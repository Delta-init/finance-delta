import { Types } from "mongoose";
import {
  CS_AED_PER_USD, CS_INR_PER_USD, EXPENSE_DEFAULTS, computeExpenseTax, hasPermission, resolveCategoryName,
  type ApproveCsCommissionInput, type CsCommissionKind, type CsCommissionPayoutView, type CsCommissionPerson, type CsCommissionPeriod,
  type CsCommissionState, type PayCsCommissionInput, type RevokeCsCommissionInput,
} from "@delta/shared";
import { AppError } from "../../lib/http";
import {
  CsCommissionRefusedError, approvePortalCsCommission, portalCsCommission, unapprovePortalCsCommission, type PortalCsCommissionPerson,
} from "../../lib/commission-client";
import { User } from "../user/user.model";
import { Organization } from "../organization/organization.model";
import { Department } from "../department/department.model";
import { Expense } from "../expense/expense.model";
import { placeExpenseInBank, uploadFormFile } from "../expense/expense.service";
import { resolveExpenseCategory } from "../expense-category/expense-category.service";
import { nextNumber } from "../sequence/sequence.service";
import { isManager } from "../late-entry/late-entry.service";
import type { ParsedFile } from "../../middleware/upload";
import { CsCommissionPayout } from "./cs-commission-payout.model";

/*
 * The CS Portal's commission in finance (the user, 2026-11-03) — see cs-commission.schema.ts. A period's commission
 * is read live from the CS Portal (POST /api/v1/integrations/finance/cs-commission, finance's own secret); approvals
 * and payments are kept here. A manager approves a CS's period — which is the CS Portal's Finance step, so it
 * releases their credits there — its amount frozen; accounts pay it with the receipt (a paid expense in its method's
 * bank or cash book), or a payroll run's "Pull commission" pays it with the CS's salary.
 */

const keyOf = (kind: string, period: string, recipientId: string) => `${kind}:${period}:${recipientId}`;
const currencyOf = (location: string): "AED" | "INR" => (location === "bangalore" ? "INR" : "AED");
/** USD at the CS Portal's fixed rate, in the CS's currency's minor units. */
const minorOf = (usd: number, currency: string) => Math.round((Number(usd) || 0) * (currency === "INR" ? CS_INR_PER_USD : CS_AED_PER_USD) * 100);
/** A period's last month: YYYY-MM, or a quarter's third month. */
export const lastMonthOf = (kind: CsCommissionKind, period: string) => {
  if (kind === "bonus") return period;
  const [y, q] = period.split("-Q");
  return `${y}-${String(Number(q) * 3).padStart(2, "0")}`;
};
const monthName = (m: string) => new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${m}-01T00:00:00Z`));
/** "Bonus, September 2026" / "Deposit, Q3 2026". */
export const periodLabel = (kind: string, period: string) =>
  kind === "bonus" ? `Bonus, ${monthName(period)}` : `Deposit, ${period.replace(/^(\d{4})-(Q\d)$/, "$2 $1")}`;

async function userName(userId: string): Promise<string> {
  return (await User.findById(userId).select("name").lean<{ name?: string } | null>())?.name ?? "";
}

/** The CS Portal's answer, or why it couldn't give one, said plainly. */
async function fromPortal<T>(ask: () => Promise<T>): Promise<T> {
  try {
    return await ask();
  } catch (err) {
    if (err instanceof CsCommissionRefusedError) throw new AppError(err.status === 400 ? "VALIDATION_ERROR" : "CONFLICT", err.message);
    throw new AppError("UNAVAILABLE", (err as Error).message);
  }
}

const stateOf = (p: PortalCsCommissionPerson, payout: any): CsCommissionState => {
  if (payout) return payout.state;
  const s = p.approval.overall_status;
  if (s === "rejected") return "rejected";
  return s === "pending_finance_approval" || s === "released" ? "ready" : "waiting";
};

/** A period, per CS: their credits and total in their currency, where the CS Portal's chain has got, and our payout. */
export async function csCommissionPeriod(orgId: string, userId: string, permissions: string[], isSuperAdmin: boolean, kind: CsCommissionKind, period: string): Promise<CsCommissionPeriod> {
  const [portal, payouts] = await Promise.all([
    fromPortal(() => portalCsCommission(kind, period)),
    CsCommissionPayout.find({ kind, period }).lean<any[]>(),
  ]);
  const byRecipient = new Map(payouts.map((p) => [String(p.recipientId), p]));
  const orgIds = [...new Set(payouts.map((p) => String(p.organizationId)))];
  const expenseIds = payouts.map((p) => p.expenseId).filter(Boolean);
  const [orgs, expenses] = await Promise.all([
    orgIds.length ? Organization.find({ _id: { $in: orgIds } }).select("name").lean<any[]>() : [],
    expenseIds.length ? Expense.find({ _id: { $in: expenseIds } }).select("expenseNumber status").lean<any[]>() : [],
  ]);
  const orgName = new Map(orgs.map((o) => [String(o._id), String(o.name ?? "")]));
  const expenseOf = new Map(expenses.map((e) => [String(e._id), e]));
  const view = (p: any): CsCommissionPayoutView => {
    const e = p.expenseId ? expenseOf.get(String(p.expenseId)) : null;
    return {
      state: p.state, amountMinor: p.amountMinor, currency: p.currency ?? "AED", amountUsd: p.amountUsd ?? 0,
      approvedByName: p.approvedByName ?? "", approvedAt: new Date(p.approvedAt).toISOString(), approvalNote: p.approvalNote ?? "",
      ...(p.state === "paid" ? {
        paidByName: p.paidByName ?? "", paidOn: p.paidOn ? new Date(p.paidOn).toISOString().slice(0, 10) : "", paymentMethod: p.paymentMethod ?? "",
        reference: p.reference ?? "",
        expense: e ? { id: String(e._id), expenseNumber: String(e.expenseNumber), status: String(e.status) } : p.expenseNumber ? { id: String(p.expenseId ?? ""), expenseNumber: p.expenseNumber, status: "gone" } : null,
        receipt: p.receipt?.url ? { name: p.receipt.name ?? "Receipt", url: p.receipt.url } : null,
      } : {}),
      orgId: String(p.organizationId), orgName: orgName.get(String(p.organizationId)) ?? "", payrollRunNumber: p.payrollRunNumber ?? "",
    };
  };

  const people: CsCommissionPerson[] = portal.people.map((p) => {
    const payout = byRecipient.get(p.recipient_id) ?? null;
    const currency = currencyOf(p.location);
    return {
      recipientId: p.recipient_id, name: p.name, email: p.email, location: p.location, currency, totalUsd: p.total_usd,
      amountMinor: minorOf(p.total_usd, currency),
      credits: p.credits.map((c) => ({
        id: c.id, date: c.date, student: c.student, method: c.method, level: c.level, position: c.position, percentage: c.percentage,
        baseUsd: c.base_usd, amountUsd: c.amount_usd, status: c.status, txnId: c.txn_id, initiator: c.initiator,
      })),
      approval: {
        overall: p.approval.overall_status, broker: p.approval.broker, academic: p.approval.academic, finance: p.approval.finance,
        releasedAt: p.approval.released_at, releasedBy: p.approval.released_by, byFinance: p.approval.by_finance,
      },
      state: stateOf(p, payout),
      payout: payout ? view(payout) : null,
    };
  });
  // Approved or paid, yet no longer in the CS Portal's period (its credits gone): still shown, so nothing paid goes missing.
  for (const p of payouts) {
    if (people.some((x) => x.recipientId === String(p.recipientId))) continue;
    const empty = { status: "", by: "", at: null };
    people.push({
      recipientId: String(p.recipientId), name: p.personName ?? "", email: p.email ?? "", location: p.location ?? "dubai", currency: p.currency === "INR" ? "INR" : "AED",
      totalUsd: 0, amountMinor: 0, credits: [],
      approval: { overall: "", broker: empty, academic: empty, finance: empty, releasedAt: null, releasedBy: "", byFinance: false },
      state: p.state, payout: view(p),
    });
  }

  const totals = new Map<string, { currency: string; amountMinor: number; approvedMinor: number; paidMinor: number }>();
  for (const p of people) {
    const t = totals.get(p.currency) ?? { currency: p.currency, amountMinor: 0, approvedMinor: 0, paidMinor: 0 };
    t.amountMinor += p.amountMinor;
    if (p.payout?.state === "approved") t.approvedMinor += p.payout.amountMinor;
    if (p.payout?.state === "paid") t.paidMinor += p.payout.amountMinor;
    totals.set(p.currency, t);
  }
  return {
    kind, period, ended: portal.ended, people, totals: [...totals.values()],
    canApprove: isSuperAdmin || (await isManager(orgId, userId)),
    canPay: isSuperAdmin || hasPermission(permissions, "commission:write"),
  };
}

/**
 * A manager approves a CS's period: the CS Portal's Finance step (their credits released there), then the amount
 * frozen here. Only once the broker admin and academic head have approved it there — or a Super Admin released it.
 */
export async function approveCsCommission(orgId: string, userId: string, isSuperAdmin: boolean, input: ApproveCsCommissionInput) {
  if (!isSuperAdmin && !(await isManager(orgId, userId))) throw new AppError("FORBIDDEN", "Only somebody tagged Manager approves commission");
  const key = keyOf(input.kind, input.period, input.recipientId);
  if (await CsCommissionPayout.exists({ key })) throw new AppError("CONFLICT", "It is already approved here");
  const by = await userName(userId);
  const done = await fromPortal(() => approvePortalCsCommission(input.kind, input.period, input.recipientId, by || "Finance"));
  if (!(done.total_usd > 0)) throw new AppError("CONFLICT", `Nothing is payable to ${done.name || "them"} for ${periodLabel(input.kind, input.period)}.`);
  const currency = currencyOf(done.location);
  try {
    await CsCommissionPayout.create({
      key, organizationId: new Types.ObjectId(orgId), kind: input.kind, period: input.period, lastMonth: lastMonthOf(input.kind, input.period),
      recipientId: input.recipientId, personName: done.name, email: done.email, location: done.location, currency,
      amountMinor: minorOf(done.total_usd, currency), amountUsd: done.total_usd, creditIds: done.credit_ids, state: "approved",
      approvedById: new Types.ObjectId(userId), approvedByName: by, approvedAt: new Date(), approvalNote: input.note ?? "",
    });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) throw new AppError("CONFLICT", "It is already approved here");
    throw err;
  }
  return { approved: true, alreadyReleased: done.already };
}

/** A manager takes an approval back — only before it is paid; the CS Portal's Finance step goes back with it. */
export async function revokeCsCommission(orgId: string, userId: string, isSuperAdmin: boolean, input: RevokeCsCommissionInput) {
  if (!isSuperAdmin && !(await isManager(orgId, userId))) throw new AppError("FORBIDDEN", "Only somebody tagged Manager approves commission");
  const key = keyOf(input.kind, input.period, input.recipientId);
  const payout = await CsCommissionPayout.findOne({ key }).select("state payrollRunId payrollRunNumber").lean<any>();
  if (!payout || payout.state !== "approved") throw new AppError("CONFLICT", "It is not waiting to be paid — paid already, or not approved");
  if (payout.payrollRunId) throw new AppError("CONFLICT", `It is on payroll ${payout.payrollRunNumber} — take it off the run first`);
  try {
    await unapprovePortalCsCommission(input.kind, input.period, input.recipientId, (await userName(userId)) || "Finance");
  } catch (err) {
    // Released by a Super Admin in the CS Portal, not by us: our approval goes, theirs stays.
    if (!(err instanceof CsCommissionRefusedError && err.code === "NOT_FINANCES")) {
      throw err instanceof CsCommissionRefusedError ? new AppError("CONFLICT", err.message) : new AppError("UNAVAILABLE", (err as Error).message);
    }
  }
  const r = await CsCommissionPayout.deleteOne({ key, state: "approved", payrollRunId: null });
  if (!r.deletedCount) throw new AppError("CONFLICT", "It is not waiting to be paid — paid already, or not approved");
  return { revoked: true };
}

/** The receipt, stored before the payment is recorded with it. */
export async function uploadReceipt(orgId: string, file: ParsedFile) {
  return uploadFormFile(orgId, file);
}

/**
 * Accounts pay an approved period: a paid expense for the approved amount, in its method's bank or cash book, the
 * receipt attached — by an organization in the CS's currency. Claimed first, so two people paying at once make one.
 */
export async function payCsCommission(orgId: string, userId: string, input: PayCsCommissionInput) {
  const key = keyOf(input.kind, input.period, input.recipientId);
  const existing = await CsCommissionPayout.findOne({ key }).select("state currency payrollRunId payrollRunNumber").lean<any>();
  if (existing?.payrollRunId) throw new AppError("CONFLICT", `It is paid through payroll ${existing.payrollRunNumber} — not here`);
  if (existing) {
    const org = await Organization.findById(orgId).select("name baseCurrency").lean<any>();
    const orgCurrency = String(org?.baseCurrency ?? "AED").toUpperCase();
    if (orgCurrency !== String(existing.currency ?? "AED").toUpperCase()) {
      throw new AppError("CONFLICT", `This commission is in ${existing.currency} — pay it from an organization that keeps its books in ${existing.currency}${existing.currency === "INR" ? " (Bangalore)" : ""}.`);
    }
  }
  if (!input.receipt.key.startsWith(`expenses/${orgId}/uploads/`) || input.receipt.key.includes("..")) {
    throw new AppError("VALIDATION_ERROR", "Upload the receipt here first");
  }
  const cat = await resolveExpenseCategory(orgId, input.category, input.subcategory, { fallbackSub: EXPENSE_DEFAULTS.csCommission.subcategory });
  if (input.departmentId && !(await Department.exists({ _id: input.departmentId, organizationId: orgId }))) {
    throw new AppError("VALIDATION_ERROR", "That department is not in this organization.");
  }
  const name = await userName(userId);
  const claimed = await CsCommissionPayout.findOneAndUpdate(
    { key, state: "approved", payrollRunId: null },
    { $set: { state: "paid", organizationId: new Types.ObjectId(orgId), paidById: new Types.ObjectId(userId), paidByName: name, paidAt: new Date(),
      paidOn: new Date(`${input.paidOn}T00:00:00.000Z`), paymentMethod: input.paymentMethod, reference: input.reference ?? "" } },
    { new: true },
  );
  if (!claimed) throw new AppError("CONFLICT", existing?.state === "paid" ? "It is paid already" : "A manager has to approve it first");
  try {
    const { publicUrlFor } = await import("../../lib/storage");
    const receipt = { name: input.receipt.name, key: input.receipt.key, url: publicUrlFor(input.receipt.key), size: input.receipt.size, mimeType: input.receipt.mimeType };
    const { netMinor, taxMinor, totalMinor } = computeExpenseTax(claimed.amountMinor, 0, false);
    const label = periodLabel(claimed.kind, claimed.period);
    const expense = await Expense.create({
      organizationId: new Types.ObjectId(orgId),
      expenseNumber: await nextNumber(orgId, "expense", "EXP-"),
      category: cat.category,
      categoryName: resolveCategoryName(cat.category, cat.categoryName, ""),
      subcategory: cat.subcategory,
      subcategoryName: cat.subcategoryName,
      description: `CS commission — ${claimed.personName} (${label})`,
      expenseDate: new Date(`${input.paidOn}T00:00:00.000Z`),
      amountMinor: netMinor, taxPct: 0, taxInclusive: false, taxMinor, totalMinor,
      currency: claimed.currency || "AED",
      submittedById: new Types.ObjectId(userId), submittedByName: name,
      status: "approved",
      approvedById: claimed.approvedById, approvedByName: claimed.approvedByName, approvedAt: claimed.approvedAt,
      paidOn: new Date(`${input.paidOn}T00:00:00.000Z`),
      paymentMethod: input.paymentMethod,
      reference: input.reference ?? "",
      departmentId: input.departmentId ? new Types.ObjectId(input.departmentId) : undefined,
      attachments: [{ ...receipt, uploadedAt: new Date() }],
      notes: [
        `CS Portal commission, ${label}: ${claimed.personName}, ${claimed.creditIds.length} credit${claimed.creditIds.length === 1 ? "" : "s"} — USD ${claimed.amountUsd.toFixed(2)} at the CS Portal's rate.`,
        `Approved by ${claimed.approvedByName}${claimed.approvalNote ? ` — ${claimed.approvalNote}` : ""}.`,
      ].join("\n"),
    });
    await placeExpenseInBank(orgId, expense._id);
    await CsCommissionPayout.updateOne({ _id: claimed._id }, { $set: { expenseId: expense._id, expenseNumber: expense.expenseNumber, receipt } });
    return { expense: { id: String(expense._id), expenseNumber: expense.expenseNumber } };
  } catch (err) {
    // Nothing recorded: back to approved, so it can be paid again.
    await CsCommissionPayout.updateOne({ _id: claimed._id, expenseId: { $exists: false } }, {
      $set: { state: "approved" }, $unset: { paidById: 1, paidByName: 1, paidAt: 1, paidOn: 1, paymentMethod: 1, reference: 1 },
    });
    throw err;
  }
}
