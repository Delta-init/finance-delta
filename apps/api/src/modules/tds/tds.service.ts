import { Types } from "mongoose";
import {
  TDS_DEFAULT_SECTIONS, tdsMinorOf,
  type BillTds, type RecordTdsPaymentInput, type TdsConfig, type TdsReport, type TdsReportQuery, type TdsReportRow, type UpdateTdsConfigInput,
} from "@delta/shared";
import { AppError } from "../../lib/http";
import { Organization } from "../organization/organization.model";
import { TdsConfigModel, TdsPaymentModel } from "./tds.model";

/*
 * TDS — tax deducted at source — on vendor bills, for the Bangalore organization only (the user, 2026-11-11: "TDS
 * section required", "is only for the bangalore only"): offered where the organization keeps its books in INR. The
 * sections and rates are the organization's (Settings → Taxes), starting from the usual ones. A bill names a section;
 * its TDS is worked out before GST, rounded to the rupee, and comes off what the vendor is paid. What was deducted is
 * owed to the government until a TDS payment says it was paid, from a Banking account.
 */

const oid = (v: unknown) => new Types.ObjectId(String(v));
const NOT_HERE = "TDS is for the organization that keeps its books in INR (Bangalore)";

async function orgCurrency(orgId: string): Promise<string> {
  return String((await Organization.findById(orgId).select("baseCurrency").lean<any>())?.baseCurrency ?? "AED");
}

export async function tdsConfig(orgId: string): Promise<TdsConfig> {
  const available = (await orgCurrency(orgId)) === "INR";
  const doc = await TdsConfigModel.findOne({ organizationId: oid(orgId) }).lean<any>();
  const sections = doc?.sections?.length ? doc.sections.map((s: any) => ({ code: s.code, label: s.label, ratePct: s.ratePct, active: s.active !== false })) : TDS_DEFAULT_SECTIONS.map((s) => ({ ...s }));
  return { available, enabled: available && (doc?.enabled ?? true), sections };
}

export async function updateTdsConfig(orgId: string, input: UpdateTdsConfigInput): Promise<TdsConfig> {
  if ((await orgCurrency(orgId)) !== "INR") throw new AppError("CONFLICT", NOT_HERE);
  const set: Record<string, unknown> = {};
  if (input.enabled !== undefined) set.enabled = input.enabled;
  if (input.sections !== undefined) set.sections = input.sections.map((s) => ({ ...s, code: s.code.trim().toUpperCase() }));
  await TdsConfigModel.updateOne({ organizationId: oid(orgId) }, { $set: set }, { upsert: true });
  return tdsConfig(orgId);
}

/**
 * A bill's TDS for this section, worked out on `baseMinor` (the bill before GST). "" — none. `strict`: a section named
 * by hand that can't be used is refused; the vendor's own section, quietly left off.
 */
export async function billTdsFor(orgId: string, code: string | undefined | null, baseMinor: number, strict: boolean): Promise<BillTds | null> {
  const wanted = String(code ?? "").trim().toUpperCase();
  if (!wanted) return null;
  const cfg = await tdsConfig(orgId);
  if (!cfg.enabled) {
    if (strict) throw new AppError("VALIDATION_ERROR", cfg.available ? "TDS is turned off for this organization (Settings → Taxes)" : NOT_HERE);
    return null;
  }
  const s = cfg.sections.find((x) => x.code.toUpperCase() === wanted && x.active);
  if (!s) {
    if (strict) throw new AppError("VALIDATION_ERROR", `No TDS section "${wanted}" — choose one from Settings → Taxes`);
    return null;
  }
  return { section: s.code, label: s.label, ratePct: s.ratePct, baseMinor: Math.max(0, baseMinor), amountMinor: tdsMinorOf(baseMinor, s.ratePct) };
}

/** A bill's TDS, as it is stored (or none). */
export const tdsOf = (doc: unknown): number => Number((doc as { tds?: { amountMinor?: number } | null })?.tds?.amountMinor ?? 0);

const monthOf = (d: Date) => new Date(d).toISOString().slice(0, 7);
const day = (d: Date) => new Date(d).toISOString().slice(0, 10);

/** What was deducted, by month and section, against what was paid — and the bills and payments behind it. */
export async function tdsReport(orgId: string, q: TdsReportQuery): Promise<TdsReport> {
  const cfg = await tdsConfig(orgId);
  if (!cfg.available) throw new AppError("CONFLICT", NOT_HERE);
  const currency = await orgCurrency(orgId);
  const { Bill } = await import("../bill/bill.model");
  const { Vendor } = await import("../vendor/vendor.model");
  const range: Record<string, Date> = {};
  if (q.from) range.$gte = new Date(`${q.from}T00:00:00.000Z`);
  if (q.to) range.$lte = new Date(`${q.to}T23:59:59.999Z`);
  const bills = await Bill.find({ organizationId: oid(orgId), status: { $ne: "voided" }, "tds.amountMinor": { $gt: 0 }, ...(q.from || q.to ? { billDate: range } : {}) })
    .select("billNumber billDate vendorId vendorName tds status").sort({ billDate: 1 }).lean<any[]>();
  const vendors = new Map((await Vendor.find({ _id: { $in: bills.map((b) => b.vendorId) } }).select("pan").lean<any[]>()).map((v) => [String(v._id), String(v.pan ?? "")]));
  const payQuery: Record<string, unknown> = { organizationId: oid(orgId) };
  if (q.from || q.to) payQuery.period = { ...(q.from ? { $gte: q.from.slice(0, 7) } : {}), ...(q.to ? { $lte: q.to.slice(0, 7) } : {}) };
  const payments = await TdsPaymentModel.find(payQuery).sort({ paidOn: 1 }).lean<any[]>();
  const { BankTransaction } = await import("../banking/bank-transaction.model");
  const lines = new Set((await BankTransaction.find({ _id: { $in: payments.map((p) => p.bankTransactionId).filter(Boolean) } }).select("_id").lean<any[]>()).map((l) => String(l._id)));

  const labels = new Map(cfg.sections.map((s) => [s.code, s.label]));
  const rows = new Map<string, TdsReportRow>();
  const rowOf = (period: string, section: string) => {
    const k = `${period}|${section}`;
    let r = rows.get(k);
    if (!r) { r = { period, section, label: section ? labels.get(section) ?? section : "All sections", bills: 0, baseMinor: 0, tdsMinor: 0, paidMinor: 0, owedMinor: 0 }; rows.set(k, r); }
    return r;
  };
  for (const b of bills) {
    const r = rowOf(monthOf(b.billDate), String(b.tds.section));
    r.bills++; r.baseMinor += Number(b.tds.baseMinor ?? 0); r.tdsMinor += Number(b.tds.amountMinor ?? 0);
  }
  for (const p of payments) rowOf(p.period, String(p.section ?? "")).paidMinor += Number(p.amountMinor ?? 0);
  // A payment for the month together ("") counts against the month's sections as one.
  const out = [...rows.values()].sort((a, b) => a.period.localeCompare(b.period) || a.section.localeCompare(b.section));
  for (const r of out) r.owedMinor = r.tdsMinor - r.paidMinor;
  const totals = out.reduce((t, r) => ({ baseMinor: t.baseMinor + r.baseMinor, tdsMinor: t.tdsMinor + r.tdsMinor, paidMinor: t.paidMinor + r.paidMinor, owedMinor: 0 }), { baseMinor: 0, tdsMinor: 0, paidMinor: 0, owedMinor: 0 });
  totals.owedMinor = totals.tdsMinor - totals.paidMinor;
  return {
    currency,
    rows: out,
    bills: bills.map((b) => ({
      id: String(b._id), billNumber: String(b.billNumber ?? ""), billDate: day(b.billDate), vendorName: String(b.vendorName ?? ""), pan: vendors.get(String(b.vendorId)) ?? "",
      section: String(b.tds.section), ratePct: Number(b.tds.ratePct ?? 0), baseMinor: Number(b.tds.baseMinor ?? 0), tdsMinor: Number(b.tds.amountMinor ?? 0), status: String(b.status ?? ""),
    })),
    payments: payments.map((p) => ({
      id: String(p._id), period: p.period, section: String(p.section ?? ""), amountMinor: Number(p.amountMinor ?? 0), paidOn: day(p.paidOn),
      accountName: String(p.accountName ?? ""), challanNo: String(p.challanNo ?? ""), notes: String(p.notes ?? ""), inBank: !!p.bankTransactionId && lines.has(String(p.bankTransactionId)),
    })),
    totals,
  };
}

/** TDS paid to the government: a money-out line in the account it was paid from, and the payment against the month. */
export async function recordTdsPayment(orgId: string, input: RecordTdsPaymentInput, userId?: string) {
  const cfg = await tdsConfig(orgId);
  if (!cfg.available) throw new AppError("CONFLICT", NOT_HERE);
  const section = String(input.section ?? "").trim().toUpperCase();
  if (section && !cfg.sections.some((s) => s.code.toUpperCase() === section)) throw new AppError("VALIDATION_ERROR", `No TDS section "${section}"`);
  const { BankAccount } = await import("../banking/bank-account.model");
  if (!Types.ObjectId.isValid(input.bankAccountId)) throw new AppError("NOT_FOUND", "Bank account not found");
  const acc = await BankAccount.findOne({ _id: oid(input.bankAccountId), organizationId: oid(orgId) }).select("accountName currency isActive").lean<any>();
  if (!acc) throw new AppError("NOT_FOUND", "Bank account not found");
  if (acc.isActive === false) throw new AppError("CONFLICT", `${acc.accountName} is closed`);
  const currency = await orgCurrency(orgId);
  if (acc.currency !== currency) throw new AppError("CONFLICT", `${acc.accountName} is in ${acc.currency} — TDS is paid in ${currency}`);
  const { addTransaction } = await import("../banking/banking.service");
  const what = [`TDS paid · ${section || "all sections"} · ${input.period}`, input.challanNo ? `challan ${input.challanNo}` : ""].filter(Boolean).join(" · ");
  const line = await addTransaction(orgId, input.bankAccountId, { date: input.paidOn, description: what, reference: input.challanNo ?? "", amountMinor: -input.amountMinor, notes: input.notes ?? "" } as never);
  const doc = await TdsPaymentModel.create({
    organizationId: oid(orgId), period: input.period, section, amountMinor: input.amountMinor, currency, paidOn: new Date(`${input.paidOn}T00:00:00.000Z`),
    bankAccountId: acc._id, accountName: acc.accountName, bankTransactionId: oid(line.id), challanNo: input.challanNo ?? "", notes: input.notes ?? "",
    createdById: userId && Types.ObjectId.isValid(userId) ? oid(userId) : null,
  });
  return { id: String(doc._id) };
}

/** A TDS payment taken back: its line out of the account first (refused once reconciled). */
export async function deleteTdsPayment(orgId: string, id: string): Promise<void> {
  if (!Types.ObjectId.isValid(id)) throw new AppError("NOT_FOUND", "TDS payment not found");
  const doc = await TdsPaymentModel.findOne({ _id: oid(id), organizationId: oid(orgId) }).lean<any>();
  if (!doc) throw new AppError("NOT_FOUND", "TDS payment not found");
  if (doc.bankTransactionId) {
    const { BankTransaction } = await import("../banking/bank-transaction.model");
    if (await BankTransaction.exists({ _id: doc.bankTransactionId })) {
      const { deleteTransaction } = await import("../banking/banking.service");
      await deleteTransaction(orgId, String(doc.bankAccountId), String(doc.bankTransactionId));
    }
  }
  await TdsPaymentModel.deleteOne({ _id: doc._id });
}
