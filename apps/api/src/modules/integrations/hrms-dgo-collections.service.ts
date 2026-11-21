import { Types } from "mongoose";
import { isVatFreePayment, toBaseMinor } from "@delta/shared";
import { AppError } from "../../lib/http";
import { Invoice } from "../invoice/invoice.model";
import { CreditNote } from "../credit-note/credit-note.model";
import { BankTransaction } from "../banking/bank-transaction.model";
import { Organization } from "../organization/organization.model";
import { PayrollOrgLink } from "../payroll-mapping/org-link.model";

/*
 * DGO Points' monthly budget in HRMS (2026-11-21): the month's eligible collections, which finance used to type into
 * HRMS by hand. HRMS asks here and enters the answer; a second person still confirms it there. Read-only.
 *
 * What counts, and how:
 *   - Every payment received on an invoice (Invoice.payments) whose paidOn falls in the Dubai month (UTC+4). That one
 *     array already holds every collection — enrolment payments, approved balance payments, CS Portal course payments
 *     — so nothing else (BalancePayment, TetraDeposit) is added on top: that would count money twice.
 *   - Not on a draft or void invoice.
 *   - Not a back-dated payment still waiting for a manager (lateEntry.state "pending"): reported apart, left out.
 *   - In the organization's base currency: a payment is in its invoice's currency, and an invoice in another currency
 *     carries its rate as `exchangeRate` — invoice-currency units per one base unit, the way createInvoice stores it
 *     (baseTotalMinor = toBaseMinor(totalMinor, exchangeRate)) — so the payment is divided by it. A rate missing or 1
 *     between two different currencies is not believed: the invoice's own baseTotalMinor / totalMinor is used instead.
 *   - Net of VAT, payment by payment: its own tax invoice's VAT on a pro-forma (taxInvoice.taxMinor); none when the
 *     payment is VAT-free (its vatFree flag, else @delta/shared isVatFreePayment for one recorded before the flag); else
 *     its share of the invoice's VAT (taxTotalMinor / totalMinor, so a zero-rated invoice gives none).
 *   - Reconciled when its bank line is reconciled (bankTransactionId → BankTransaction.isReconciled); both parts given.
 *   - Credit notes issued in the month are reported for information only: they return no cash, so nothing is
 *     subtracted. Finance has no record of a cash refund paid out; finance lowers the figure in HRMS for those.
 */

const DUBAI_OFFSET_MS = 4 * 3_600_000;
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** The Dubai month as instants: [start, end). */
export function dubaiMonthRange(month: string): { start: Date; end: Date } {
  const m = MONTH.exec(month);
  if (!m) throw new AppError("VALIDATION_ERROR", "month is YYYY-MM");
  const y = Number(m[1]), mo = Number(m[2]);
  return { start: new Date(Date.UTC(y, mo - 1, 1) - DUBAI_OFFSET_MS), end: new Date(Date.UTC(y, mo, 1) - DUBAI_OFFSET_MS) };
}

const thisDubaiMonth = (at = Date.now()) => new Date(at + DUBAI_OFFSET_MS).toISOString().slice(0, 7);
const major = (minor: number) => Math.round(minor) / 100;

type Pay = {
  _id: Types.ObjectId;
  method?: string;
  amountMinor: number;
  paidOn: Date;
  original?: { currency?: string; amountMinor?: number } | null;
  bankCurrency?: string | null;
  bankAmountMinor?: number | null;
  vatFree?: boolean | null;
  taxInvoice?: { taxMinor?: number | null } | null;
  bankTransactionId?: Types.ObjectId | null;
  lateEntry?: { state?: string } | null;
};
type Inv = {
  _id: Types.ObjectId;
  currency?: string | null;
  exchangeRate?: number | null;
  totalMinor?: number | null;
  baseTotalMinor?: number | null;
  taxTotalMinor?: number | null;
  payments: Pay[];
};

/** An amount in this invoice's currency, in the organization's base currency. */
function toBaseFor(inv: Pick<Inv, "currency" | "exchangeRate" | "totalMinor" | "baseTotalMinor">, base: string) {
  const cur = String(inv.currency || base).toUpperCase();
  if (cur === base) return (minor: number) => minor;
  const rate = Number(inv.exchangeRate);
  if (Number.isFinite(rate) && rate > 0 && rate !== 1) return (minor: number) => toBaseMinor(minor, rate);
  const total = Number(inv.totalMinor) || 0, baseTotal = Number(inv.baseTotalMinor) || 0;
  if (total > 0 && baseTotal > 0) return (minor: number) => Math.round((minor * baseTotal) / total);
  return (minor: number) => minor;
}

/** The VAT inside one payment, in its invoice's currency. */
export function paymentVatMinor(p: Pay, inv: Pick<Inv, "currency" | "totalMinor" | "taxTotalMinor">): number {
  const amount = Number(p.amountMinor) || 0;
  if (p.taxInvoice && typeof p.taxInvoice.taxMinor === "number") return Math.max(0, Math.min(amount, p.taxInvoice.taxMinor));
  const free = typeof p.vatFree === "boolean" ? p.vatFree : isVatFreePayment(p, inv.currency);
  if (free) return 0;
  const total = Number(inv.totalMinor) || 0, tax = Number(inv.taxTotalMinor) || 0;
  if (total <= 0 || tax <= 0) return 0;
  return Math.max(0, Math.min(amount, Math.round((amount * tax) / total)));
}

export interface DgoCollections {
  month: string;
  currency: string;
  grossAed: number;
  vatAed: number;
  netAed: number;
  reconciledNetAed: number;
  unreconciledNetAed: number;
  pendingLateEntries: { count: number; netAed: number };
  payments: number;
  byMethod: Array<{ method: string; count: number; netAed: number }>;
  creditNotes: { count: number; totalAed: number };
  computedAt: string;
  organization: { id: string; name: string };
}

export async function dgoCollectionsForHrms(input: { hrmsOrgId: string; month: string }): Promise<DgoCollections> {
  const { start, end } = dubaiMonthRange(input.month);
  if (input.month > thisDubaiMonth()) throw new AppError("VALIDATION_ERROR", "That month hasn't started");
  const link = await PayrollOrgLink.findOne({ hrmsOrgId: input.hrmsOrgId, isActive: { $ne: false } }).select("organizationId").lean<{ organizationId: Types.ObjectId }>();
  // 409, not 404: HRMS reads a 404 as "finance needs updating", which this is not.
  if (!link) throw new AppError("CONFLICT", "This HRMS organisation isn't linked to a finance organisation");
  const org = await Organization.findById(link.organizationId).select("name baseCurrency").lean<{ _id: Types.ObjectId; name: string; baseCurrency?: string }>();
  if (!org) throw new AppError("CONFLICT", "This HRMS organisation isn't linked to a finance organisation");
  const base = String(org.baseCurrency || "AED").toUpperCase();

  const invoices = await Invoice.find({
    organizationId: org._id,
    status: { $nin: ["draft", "void"] },
    payments: { $elemMatch: { paidOn: { $gte: start, $lt: end } } },
  })
    .select("currency exchangeRate totalMinor baseTotalMinor taxTotalMinor payments")
    .lean<Inv[]>();

  type Row = { method: string; gross: number; vat: number; net: number; bankLine: string | null };
  const rows: Row[] = [];
  let pendingCount = 0, pendingNet = 0;
  for (const inv of invoices) {
    const toBase = toBaseFor(inv, base);
    for (const p of inv.payments ?? []) {
      const at = new Date(p.paidOn).getTime();
      if (!(at >= start.getTime() && at < end.getTime())) continue;
      const gross = toBase(Number(p.amountMinor) || 0);
      const vat = toBase(paymentVatMinor(p, inv));
      const net = gross - vat;
      if (p.lateEntry?.state === "pending") { pendingCount++; pendingNet += net; continue; }
      rows.push({ method: String(p.method || "other"), gross, vat, net, bankLine: p.bankTransactionId ? String(p.bankTransactionId) : null });
    }
  }

  const lineIds = [...new Set(rows.map((r) => r.bankLine).filter((x): x is string => Boolean(x)))];
  const reconciled = new Set(
    lineIds.length
      ? (await BankTransaction.find({ _id: { $in: lineIds.map((id) => new Types.ObjectId(id)) }, isReconciled: true }).select("_id").lean<Array<{ _id: Types.ObjectId }>>()).map((t) => String(t._id))
      : [],
  );

  const methods = new Map<string, { count: number; net: number }>();
  let gross = 0, vat = 0, net = 0, recNet = 0;
  for (const r of rows) {
    gross += r.gross; vat += r.vat; net += r.net;
    if (r.bankLine && reconciled.has(r.bankLine)) recNet += r.net;
    const m = methods.get(r.method) ?? { count: 0, net: 0 };
    m.count++; m.net += r.net;
    methods.set(r.method, m);
  }

  // Credit notes: information only. A note in another currency is converted at its invoice's rate.
  const notes = await CreditNote.find({ organizationId: org._id, status: { $in: ["issued", "applied"] }, issuedAt: { $gte: start, $lt: end } })
    .select("totalMinor currency invoiceId").lean<Array<{ totalMinor?: number; currency?: string; invoiceId: Types.ObjectId }>>();
  const foreign = notes.filter((n) => String(n.currency || base).toUpperCase() !== base).map((n) => n.invoiceId);
  const noteInvoices = foreign.length
    ? new Map((await Invoice.find({ _id: { $in: foreign } }).select("currency exchangeRate totalMinor baseTotalMinor").lean<Inv[]>()).map((i) => [String(i._id), i]))
    : new Map<string, Inv>();
  const notesTotal = notes.reduce((s, n) => {
    const inv = noteInvoices.get(String(n.invoiceId));
    const toBase = inv ? toBaseFor(inv, base) : (x: number) => x;
    return s + toBase(Number(n.totalMinor) || 0);
  }, 0);

  return {
    month: input.month,
    currency: base,
    grossAed: major(gross),
    vatAed: major(vat),
    netAed: major(net),
    reconciledNetAed: major(recNet),
    unreconciledNetAed: major(net - recNet),
    pendingLateEntries: { count: pendingCount, netAed: major(pendingNet) },
    payments: rows.length,
    byMethod: [...methods.entries()]
      .map(([method, m]) => ({ method, count: m.count, netAed: major(m.net) }))
      .sort((a, b) => b.netAed - a.netAed || a.method.localeCompare(b.method)),
    creditNotes: { count: notes.length, totalAed: major(notesTotal) },
    computedAt: new Date().toISOString(),
    organization: { id: String(org._id), name: org.name },
  };
}
