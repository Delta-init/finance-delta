import { Types } from "mongoose";
import {
  EXPENSE_DEFAULTS, computeExpenseTax, hasPermission, resolveCategoryName,
  type ApproveCrmCommissionInput, type CrmCommissionCrm, type CrmCommissionLine, type CrmCommissionMonth,
  type CrmCommissionPayoutView, type PayCrmCommissionInput, type RevokeCrmCommissionInput,
} from "@delta/shared";
import { env } from "../../config/env";
import { AppError } from "../../lib/http";
import { User } from "../user/user.model";
import { Organization } from "../organization/organization.model";
import { Department } from "../department/department.model";
import { Expense } from "../expense/expense.model";
import { placeExpenseInBank, uploadFormFile } from "../expense/expense.service";
import { resolveExpenseCategory } from "../expense-category/expense-category.service";
import { nextNumber } from "../sequence/sequence.service";
import { isManager } from "../late-entry/late-entry.service";
import type { ParsedFile } from "../../middleware/upload";
import { CrmCommissionPayout } from "./crm-commission-payout.model";

/*
 * The sales CRMs' commission in finance (the user, 2026-10-21) — see crm-commission.schema.ts. The CRMs' counted
 * commission is read live from the Root portal (GET /api/v1/service/crm-commission, finance's own secret); approvals
 * and payments are kept here. A manager approves a person's month (its amount frozen), accounts pay it with the
 * receipt — a paid expense, in its method's bank or cash book, the receipt on it.
 */

/**
 * A person as Root gives them: `amount` the commission earned (every line added up); `payable` what the CRM's My Pay
 * pays of it — the slab level's percent (2026-10-21: "finance pays My Pay's commission payable"), null when the CRM
 * couldn't say.
 */
interface RootPerson {
  userId: string; name: string; roles: string[]; amount: number; sales: number; lines: CrmCommissionLine[];
  payable?: number | null; percent?: number | null; level?: string | null;
}
interface RootCrm {
  code: string; name: string; currency: string; error: string | null; people: RootPerson[]; total: number; pending: { progress: number; waiting: number };
  /** Why the CRM's My Pay figures are missing, when they are. */
  payError?: string | null; payableTotal?: number | null;
}

const keyOf = (crm: string, month: string, userId: string) => `${crm}:${month}:${userId}`;
const minor = (major: number) => Math.round((Number(major) || 0) * 100);

/** The month's counted commission of every sales CRM, from Root. */
async function fromRoot(month: string): Promise<RootCrm[]> {
  const base = env.ROOT_ERP_API_URL.replace(/\/+$/, "");
  if (!base || !env.ROOT_ERP_SECRET) throw new AppError("UNAVAILABLE", "The Root portal is not configured on this server (ROOT_ERP_API_URL, ROOT_ERP_SECRET).");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(`${base}/api/v1/service/crm-commission?month=${encodeURIComponent(month)}`, {
      headers: { "x-portal-secret": env.ROOT_ERP_SECRET }, signal: controller.signal,
    });
    if (res.status === 404) throw new AppError("UNAVAILABLE", "The Root portal needs updating before it can give the CRMs' commission.");
    const body = (await res.json().catch(() => ({}))) as { data?: { crms?: RootCrm[] }; message?: string };
    if (!res.ok || !body.data?.crms) throw new AppError("UNAVAILABLE", `The Root portal could not give the CRMs' commission${body.message ? `: ${body.message}` : ` (${res.status})`}.`);
    return body.data.crms;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("UNAVAILABLE", `The Root portal could not be reached: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function canApprove(orgId: string, userId: string): Promise<boolean> {
  return isManager(orgId, userId);
}

async function userName(userId: string): Promise<string> {
  return (await User.findById(userId).select("name").lean<{ name?: string } | null>())?.name ?? "";
}

/** The month, per CRM and person, with where each stands. */
export async function crmCommissionMonth(orgId: string, userId: string, permissions: string[], isSuperAdmin: boolean, month: string): Promise<CrmCommissionMonth> {
  const [crms, payouts] = await Promise.all([fromRoot(month), CrmCommissionPayout.find({ month }).lean<any[]>()]);
  const byKey = new Map(payouts.map((p) => [String(p.key), p]));
  const orgIds = [...new Set(payouts.map((p) => String(p.organizationId)))];
  const expenseIds = payouts.map((p) => p.expenseId).filter(Boolean);
  const [orgs, expenses] = await Promise.all([
    orgIds.length ? Organization.find({ _id: { $in: orgIds } }).select("name").lean<any[]>() : [],
    expenseIds.length ? Expense.find({ _id: { $in: expenseIds } }).select("expenseNumber status").lean<any[]>() : [],
  ]);
  const orgName = new Map(orgs.map((o) => [String(o._id), String(o.name ?? "")]));
  const expenseOf = new Map(expenses.map((e) => [String(e._id), e]));

  const view = (p: any): CrmCommissionPayoutView => {
    const e = p.expenseId ? expenseOf.get(String(p.expenseId)) : null;
    return {
      state: p.state, amountMinor: p.amountMinor, approvedByName: p.approvedByName ?? "", approvedAt: new Date(p.approvedAt).toISOString(),
      approvalNote: p.approvalNote ?? "",
      ...(p.state === "paid" ? {
        paidByName: p.paidByName ?? "", paidOn: p.paidOn ? new Date(p.paidOn).toISOString().slice(0, 10) : "", paymentMethod: p.paymentMethod ?? "",
        reference: p.reference ?? "",
        expense: e ? { id: String(e._id), expenseNumber: String(e.expenseNumber), status: String(e.status) } : p.expenseNumber ? { id: String(p.expenseId ?? ""), expenseNumber: p.expenseNumber, status: "gone" } : null,
        receipt: p.receipt?.url ? { name: p.receipt.name ?? "Receipt", url: p.receipt.url } : null,
      } : {}),
      orgId: String(p.organizationId), orgName: orgName.get(String(p.organizationId)) ?? "",
    };
  };

  const out: CrmCommissionCrm[] = crms.map((c) => ({
    code: c.code, name: c.name, currency: c.currency || "AED", error: c.error, totalMinor: minor(c.payableTotal ?? 0),
    earnedTotalMinor: minor(c.total), payError: c.payError ?? (c.payableTotal === undefined ? "The Root portal needs updating to give My Pay's figures." : null),
    pending: c.pending ?? { progress: 0, waiting: 0 },
    people: (c.people ?? []).map((p) => {
      const payout = byKey.get(keyOf(c.code, month, p.userId));
      const payable = typeof p.payable === "number" ? minor(p.payable) : null;
      return {
        userId: p.userId, name: p.name, roles: p.roles ?? [], amountMinor: payable ?? 0, payableKnown: payable !== null,
        earnedMinor: minor(p.amount), percent: p.percent ?? null, level: p.level ?? null, sales: p.sales ?? 0, lines: p.lines ?? [],
        state: payout ? payout.state : "earned",
        payout: payout ? view(payout) : null,
        changed: !!payout && payable !== null && payout.amountMinor !== payable,
      };
    }),
  }));
  // Approved or paid, yet no longer in the CRM's month (every sale reversed): still shown, so nothing paid goes missing.
  for (const p of payouts) {
    const crm = out.find((c) => c.code === p.crm);
    if (!crm || crm.people.some((x) => x.userId === p.userId)) continue;
    crm.people.push({
      userId: p.userId, name: p.personName, roles: p.roles ?? [], amountMinor: 0, payableKnown: true, earnedMinor: 0, percent: null, level: null,
      sales: 0, lines: [], state: p.state, payout: view(p), changed: true,
    });
  }

  return {
    month,
    crms: out,
    me: { canApprove: isSuperAdmin || (await canApprove(orgId, userId)), canPay: isSuperAdmin || hasPermission(permissions, "commission:write") },
  };
}

/** The person's month as the CRM counts it now — what is approved. */
async function personNow(input: { crm: string; month: string; userId: string }) {
  const crm = (await fromRoot(input.month)).find((c) => c.code === input.crm);
  if (!crm) throw new AppError("NOT_FOUND", "That CRM is not in the Root portal.");
  if (crm.error) throw new AppError("UNAVAILABLE", `${crm.name} can't be read right now: ${crm.error}`);
  const person = crm.people.find((p) => p.userId === input.userId);
  if (!person) throw new AppError("NOT_FOUND", "Nothing is counted for this person in this month.");
  if (typeof person.payable !== "number") {
    throw new AppError("UNAVAILABLE", `${crm.name}'s My Pay figures aren't available${crm.payError ? ` (${crm.payError})` : ""} — what is payable can't be known yet.`);
  }
  if (!(person.payable > 0)) throw new AppError("CONFLICT", `Nothing is payable to ${person.name} for this month — their slab level pays ${person.percent ?? 0}% of the commission.`);
  return { crm, person, payable: person.payable };
}

/** A manager approves a person's month: its amount is frozen as the CRM counts it now. */
export async function approveCrmCommission(orgId: string, userId: string, isSuperAdmin: boolean, input: ApproveCrmCommissionInput) {
  if (!isSuperAdmin && !(await canApprove(orgId, userId))) throw new AppError("FORBIDDEN", "Only somebody tagged Manager approves commission");
  const { crm, person, payable } = await personNow(input);
  const key = keyOf(input.crm, input.month, input.userId);
  if (await CrmCommissionPayout.exists({ key })) throw new AppError("CONFLICT", `${person.name}'s ${input.month} commission is already approved`);
  try {
    await CrmCommissionPayout.create({
      key, organizationId: new Types.ObjectId(orgId), crm: crm.code, crmName: crm.name, month: input.month, userId: input.userId,
      personName: person.name, roles: person.roles, currency: crm.currency || "AED", amountMinor: minor(payable), earnedMinor: minor(person.amount),
      percent: person.percent ?? null, level: person.level ?? null, sales: person.sales,
      saleIds: [...new Set(person.lines.map((l) => l.saleId))], state: "approved",
      approvedById: new Types.ObjectId(userId), approvedByName: await userName(userId), approvedAt: new Date(), approvalNote: input.note ?? "",
    });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) throw new AppError("CONFLICT", `${person.name}'s ${input.month} commission is already approved`);
    throw err;
  }
  return { approved: true };
}

/** A manager takes an approval back — only before it is paid. */
export async function revokeCrmCommission(orgId: string, userId: string, isSuperAdmin: boolean, input: RevokeCrmCommissionInput) {
  if (!isSuperAdmin && !(await canApprove(orgId, userId))) throw new AppError("FORBIDDEN", "Only somebody tagged Manager approves commission");
  const r = await CrmCommissionPayout.deleteOne({ key: keyOf(input.crm, input.month, input.userId), state: "approved" });
  if (!r.deletedCount) throw new AppError("CONFLICT", "It is not waiting to be paid — paid already, or not approved");
  return { revoked: true };
}

/** The receipt, stored before the payment is recorded with it. */
export async function uploadReceipt(orgId: string, file: ParsedFile) {
  return uploadFormFile(orgId, file);
}

/**
 * Accounts pay an approved month: a paid expense for the approved amount, in its method's bank or cash book, the
 * receipt attached. Claimed first, so two people paying at once make one expense.
 */
export async function payCrmCommission(orgId: string, userId: string, input: PayCrmCommissionInput) {
  const key = keyOf(input.crm, input.month, input.userId);
  if (!input.receipt.key.startsWith(`expenses/${orgId}/uploads/`) || input.receipt.key.includes("..")) {
    throw new AppError("VALIDATION_ERROR", "Upload the receipt here first");
  }
  const cat = await resolveExpenseCategory(orgId, input.category, input.subcategory, { fallbackSub: EXPENSE_DEFAULTS.crmCommission.subcategory });
  if (input.departmentId && !(await Department.exists({ _id: input.departmentId, organizationId: orgId }))) {
    throw new AppError("VALIDATION_ERROR", "That department is not in this organization.");
  }
  const name = await userName(userId);
  const claimed = await CrmCommissionPayout.findOneAndUpdate(
    { key, state: "approved" },
    { $set: { state: "paid", organizationId: new Types.ObjectId(orgId), paidById: new Types.ObjectId(userId), paidByName: name, paidAt: new Date(),
      paidOn: new Date(`${input.paidOn}T00:00:00.000Z`), paymentMethod: input.paymentMethod, reference: input.reference ?? "" } },
    { new: true },
  );
  if (!claimed) {
    const p = await CrmCommissionPayout.findOne({ key }).select("state").lean<{ state?: string } | null>();
    throw new AppError("CONFLICT", p?.state === "paid" ? "It is paid already" : "A manager has to approve it first");
  }
  try {
    const { publicUrlFor } = await import("../../lib/storage");
    const receipt = { name: input.receipt.name, key: input.receipt.key, url: publicUrlFor(input.receipt.key), size: input.receipt.size, mimeType: input.receipt.mimeType };
    const { netMinor, taxMinor, totalMinor } = computeExpenseTax(claimed.amountMinor, 0, false);
    const now = new Date();
    const roles = (claimed.roles ?? []).map((r) => (r === "tl" ? "team leader" : r === "sm" ? "sales manager" : "salesperson")).join(", ");
    const expense = await Expense.create({
      organizationId: new Types.ObjectId(orgId),
      expenseNumber: await nextNumber(orgId, "expense", "EXP-"),
      category: cat.category,
      categoryName: resolveCategoryName(cat.category, cat.categoryName, ""),
      subcategory: cat.subcategory,
      subcategoryName: cat.subcategoryName,
      description: `Sales commission — ${claimed.personName} (${claimed.crmName}, ${claimed.month})`,
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
      attachments: [{ ...receipt, uploadedAt: now }],
      notes: [
        `${claimed.crmName} commission for ${claimed.month}: ${claimed.personName} (${roles || "salesperson"}), ${claimed.sales} sale${claimed.sales === 1 ? "" : "s"}.`,
        `Approved by ${claimed.approvedByName}${claimed.approvalNote ? ` — ${claimed.approvalNote}` : ""}.`,
      ].join("\n"),
    });
    await placeExpenseInBank(orgId, expense._id);
    await CrmCommissionPayout.updateOne({ _id: claimed._id }, { $set: { expenseId: expense._id, expenseNumber: expense.expenseNumber, receipt } });
    return { expense: { id: String(expense._id), expenseNumber: expense.expenseNumber } };
  } catch (err) {
    // Nothing recorded: back to approved, so it can be paid again.
    await CrmCommissionPayout.updateOne({ _id: claimed._id, expenseId: { $exists: false } }, {
      $set: { state: "approved" }, $unset: { paidById: 1, paidByName: 1, paidAt: 1, paidOn: 1, paymentMethod: 1, reference: 1 },
    });
    throw err;
  }
}

/** A CRM's payouts for a month — what its My Pay shows (GET /integrations/crm-commission/payouts, 2026-10-21). */
export async function payoutsForCrm(crm: string, month: string) {
  const rows = await CrmCommissionPayout.find({ crm, month }).lean<any[]>();
  return rows.map((p) => ({
    userId: String(p.userId),
    state: p.state as "approved" | "paid",
    amount: (p.amountMinor ?? 0) / 100,
    currency: p.currency ?? "AED",
    approvedByName: p.approvedByName ?? "",
    approvedAt: new Date(p.approvedAt).toISOString(),
    paidOn: p.paidOn ? new Date(p.paidOn).toISOString().slice(0, 10) : null,
    paymentMethod: p.paymentMethod ?? null,
    reference: p.reference ?? null,
  }));
}

