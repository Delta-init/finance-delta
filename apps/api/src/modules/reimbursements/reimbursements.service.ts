import { Types } from "mongoose";
import type { PayReimbursementInput, RejectReimbursementInput } from "@delta/shared";
import { EXPENSE_DEFAULTS, computeExpenseTax, resolveCategoryName } from "@delta/shared";
import { PayrollOrgLink } from "../payroll-mapping/org-link.model";
import { PayrollDeptLink } from "../payroll-mapping/dept-link.model";
import { hrmsClient, type HrmsReimbursement, type HrmsReimbursementHistoryStatus } from "../../lib/hrms-client";
import { Expense } from "../expense/expense.model";
import { placeExpenseInBank } from "../expense/expense.service";
import { resolveExpenseCategory } from "../expense-category/expense-category.service";
import { Department } from "../department/department.model";
import { User } from "../user/user.model";
import { nextNumber } from "../sequence/sequence.service";
import { AppError } from "../../lib/http";
import { forgetReimbursements } from "../approvals/approvals.service";

/**
 * Employees' reimbursement claims HR approved in HRMS, paid by finance (the user, 2026-11-16: "employee request => HR
 * approval => finance approval (paid status)").
 *
 * The same shape as salary advances and one-time payments: read live from HRMS, nothing mirrored. "Approve and pay"
 * records a paid expense — the amount claimed, on the date and by the method finance gives — then tells HRMS, which
 * shows the claim Paid with the expense number and tells the employee. If HRMS can't be told, approving again only
 * resends: no second expense. Such a claim never goes into a payslip. Refusing needs a reason the employee sees.
 */

async function linkedOrgIds(orgId: string): Promise<string[]> {
  const links = await PayrollOrgLink.find({ organizationId: new Types.ObjectId(orgId) }).select("hrmsOrgId").lean();
  return links.map((l) => String(l.hrmsOrgId));
}

/** One expense per claim — it is decided once. */
function sourceKey(hrmsOrgId: string, id: string): string {
  return `hrms-reimbursement:${hrmsOrgId}:${id}`;
}

/** The expense subcategory a claim's HRMS category suggests — under Employee Reimbursements; finance may change it. */
export function suggestedSubcategory(hrmsCategory: string): string {
  if (hrmsCategory === "food") return "staff_meals";
  if (hrmsCategory === "communication") return "mobile_expenses";
  return EXPENSE_DEFAULTS.reimbursement.subcategory;
}

/** An HRMS without the finance step has no such route: say that, not "could not reach". */
function unread(err: unknown): never {
  const msg = (err as Error).message ?? "";
  if (/\(404\)/.test(msg)) throw new AppError("UNAVAILABLE", "HRMS needs updating before finance can pay reimbursements.");
  throw err;
}

type Made = { id: string; expenseNumber: string; status: string } | null;

export interface ReimbursementRow extends HrmsReimbursement {
  hrmsOrgId: string;
  /** The finance department the employee's HRMS department is linked to, when it is. */
  suggestedDepartmentId: string | null;
  /** The expense subcategory suggested by the claim's category. */
  suggestedSubcategory: string;
  /** An expense already made for it, whose answer HRMS never took. */
  expense: Made;
}

/** Everything waiting on finance, across every linked HRMS organisation — oldest HR approval first. */
export async function listWaiting(orgId: string): Promise<ReimbursementRow[]> {
  if (!hrmsClient.isConfigured()) throw new AppError("CONFLICT", "The HRMS integration is not configured.");
  const hrmsOrgIds = await linkedOrgIds(orgId);
  const rows: Array<HrmsReimbursement & { hrmsOrgId: string }> = [];
  for (const hrmsOrgId of hrmsOrgIds) {
    rows.push(...(await hrmsClient.reimbursements(hrmsOrgId).catch(unread)).map((r) => ({ ...r, hrmsOrgId })));
  }
  const [deptLinks, made] = await Promise.all([
    PayrollDeptLink.find({ organizationId: new Types.ObjectId(orgId), hrmsOrgId: { $in: hrmsOrgIds }, isActive: { $ne: false } })
      .select("hrmsOrgId hrmsDepartmentId departmentId").lean(),
    rows.length
      ? Expense.find({ organizationId: new Types.ObjectId(orgId), "source.key": { $in: rows.map((r) => sourceKey(r.hrmsOrgId, r._id)) } })
        .select("expenseNumber status source").lean()
      : [],
  ]);
  const deptFor = new Map(deptLinks.map((l) => [`${l.hrmsOrgId}:${l.hrmsDepartmentId}`, String(l.departmentId)]));
  const madeFor = new Map(made.map((e) => [String(e.source?.key), e]));
  return rows
    .map((r) => {
      const e = madeFor.get(sourceKey(r.hrmsOrgId, r._id));
      const dept = r.employee?.department?._id;
      return {
        ...r,
        suggestedDepartmentId: dept ? deptFor.get(`${r.hrmsOrgId}:${dept}`) ?? null : null,
        suggestedSubcategory: suggestedSubcategory(r.category),
        expense: e ? { id: String(e._id), expenseNumber: String(e.expenseNumber), status: String(e.status) } : null,
      };
    })
    .sort((a, b) => String(a.hrReviewedAt ?? a.createdAt).localeCompare(String(b.hrReviewedAt ?? b.createdAt)));
}

export const REIMBURSEMENT_HISTORY_STATUSES = ["paid", "rejected", "all"] as const satisfies readonly HrmsReimbursementHistoryStatus[];

export interface ReimbursementHistoryRow extends HrmsReimbursement {
  hrmsOrgId: string;
  /** The expense finance recorded when it paid it, when there is one. */
  expense: Made;
}

/** Finance's record: paid by it, refused by it, or every claim that reached it — newest decision first. */
export async function listHistory(orgId: string, status: HrmsReimbursementHistoryStatus): Promise<ReimbursementHistoryRow[]> {
  if (!hrmsClient.isConfigured()) throw new AppError("CONFLICT", "The HRMS integration is not configured.");
  const hrmsOrgIds = await linkedOrgIds(orgId);
  const rows: Array<HrmsReimbursement & { hrmsOrgId: string }> = [];
  for (const hrmsOrgId of hrmsOrgIds) {
    rows.push(...(await hrmsClient.reimbursementHistory(hrmsOrgId, status).catch(unread)).map((r) => ({ ...r, hrmsOrgId })));
  }
  const made = rows.length
    ? await Expense.find({ organizationId: new Types.ObjectId(orgId), "source.key": { $in: rows.map((r) => sourceKey(r.hrmsOrgId, r._id)) } })
      .select("expenseNumber status source").lean()
    : [];
  const madeFor = new Map(made.map((e) => [String(e.source?.key), e]));
  const when = (r: HrmsReimbursement) => String(r.financeReviewedAt ?? r.hrReviewedAt ?? r.createdAt);
  return rows
    .map((r) => {
      const e = madeFor.get(sourceKey(r.hrmsOrgId, r._id));
      return { ...r, expense: e ? { id: String(e._id), expenseNumber: String(e.expenseNumber), status: String(e.status) } : null };
    })
    .sort((a, b) => when(b).localeCompare(when(a)));
}

async function requireRow(orgId: string, hrmsOrgId: string, id: string): Promise<HrmsReimbursement> {
  if (!(await linkedOrgIds(orgId)).includes(hrmsOrgId)) throw new AppError("FORBIDDEN", "That organisation is not linked to this one.");
  const row = (await hrmsClient.reimbursements(hrmsOrgId).catch(unread)).find((r) => r._id === id);
  if (!row) throw new AppError("NOT_FOUND", "That claim is no longer waiting on finance.");
  return row;
}

function notesFor(row: HrmsReimbursement, note: string): string {
  return [
    "Reimbursement claim approved in HRMS, paid by finance (not on the payslip).",
    row.employee?.name ? `Employee: ${row.employee.name}${row.employee.employeeCode ? ` (${row.employee.employeeCode})` : ""}` : "",
    `Claim: ${row.title} · ${row.category}${row.expenseDate ? ` · spent ${row.expenseDate}` : ""}`,
    row.description ? `Details: ${row.description}` : "",
    row.receiptUrl ? `Receipt: ${row.receiptUrl}` : "",
    row.hrReviewedBy?.name ? `Approved in HR by ${row.hrReviewedBy.name}` : "",
    row.hrNote ? `HR note: ${row.hrNote}` : "",
    note ? `Finance note: ${note}` : "",
  ].filter(Boolean).join("\n");
}

async function makeExpense(orgId: string, userId: string, userName: string, hrmsOrgId: string, row: HrmsReimbursement, input: PayReimbursementInput) {
  const key = sourceKey(hrmsOrgId, row._id);
  if (!input.category) throw new AppError("VALIDATION_ERROR", "Choose an expense category.");
  const cat = await resolveExpenseCategory(orgId, input.category, input.subcategory, { fallbackSub: suggestedSubcategory(row.category) });
  if (input.departmentId && !(await Department.exists({ _id: input.departmentId, organizationId: orgId }))) {
    throw new AppError("VALIDATION_ERROR", "That department is not in this organization.");
  }
  const currency = (row.currency || "AED").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new AppError("VALIDATION_ERROR", `The employee's currency "${row.currency}" is not a currency code.`);
  // The amount claimed — not changed here (the user's choice, 2026-11-16).
  const amountMinor = Math.round(row.amount * 100);
  if (!(amountMinor > 0)) throw new AppError("VALIDATION_ERROR", "This claim has no amount.");

  const { netMinor, taxMinor, totalMinor } = computeExpenseTax(amountMinor, 0, false);
  const now = new Date();
  await Expense.init();
  const expenseNumber = await nextNumber(orgId, "expense", "EXP-");
  try {
    return await Expense.create({
      organizationId: new Types.ObjectId(orgId),
      expenseNumber,
      category: cat.category,
      categoryName: resolveCategoryName(cat.category, cat.categoryName, ""),
      subcategory: cat.subcategory,
      subcategoryName: cat.subcategoryName,
      description: `Reimbursement — ${row.title} — ${row.employee?.name ?? "employee"}`,
      expenseDate: row.expenseDate ? new Date(`${row.expenseDate}T00:00:00.000Z`) : new Date(now.toISOString().slice(0, 10)),
      amountMinor: netMinor,
      taxPct: 0,
      taxInclusive: false,
      taxMinor,
      totalMinor,
      currency,
      submittedById: new Types.ObjectId(userId),
      submittedByName: userName,
      status: "approved",
      approvedById: new Types.ObjectId(userId),
      approvedByName: userName,
      approvedAt: now,
      // Marked paid here — this page records the money going, not a promise of it.
      paidOn: new Date(`${input.paidOn}T00:00:00.000Z`),
      paymentMethod: input.paymentMethod,
      reference: input.reference || "",
      departmentId: input.departmentId ? new Types.ObjectId(input.departmentId) : undefined,
      notes: notesFor(row, input.note),
      source: { kind: "hrms_reimbursement", key, hrmsOrgId, requestId: row._id, round: 0 },
    });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      const theirs = await Expense.findOne({ "source.key": key });
      if (theirs) return theirs;
    }
    throw err;
  }
}

/**
 * Approve and pay: the paid expense first, in its method's bank account, then HRMS is told — so if HRMS can't be
 * told, approving again only resends the answer.
 */
export async function pay(orgId: string, userId: string, id: string, input: PayReimbursementInput) {
  const row = await requireRow(orgId, input.hrmsOrgId, id);
  const user = await User.findById(userId).select("name").lean();
  if (!user) throw new AppError("NOT_FOUND", "User not found");
  let expense = await Expense.findOne({ organizationId: orgId, "source.key": sourceKey(input.hrmsOrgId, row._id) });
  if (expense?.status === "voided") {
    throw new AppError("CONFLICT", `${expense.expenseNumber} was made for this claim and then voided. Refuse the claim instead.`);
  }
  expense ??= await makeExpense(orgId, userId, user.name, input.hrmsOrgId, row, input);
  await placeExpenseInBank(orgId, expense._id);

  if (!expense.source?.deliveredAt) {
    try {
      await hrmsClient.payReimbursement(input.hrmsOrgId, id, {
        reference: expense.expenseNumber,
        // What the expense says, so the two systems agree even on a resend.
        paidOn: expense.paidOn ? new Date(expense.paidOn).toISOString().slice(0, 10) : input.paidOn,
        method: expense.paymentMethod ?? input.paymentMethod,
        amount: expense.totalMinor / 100,
        note: input.note || undefined,
        by: user.name,
      });
    } catch (err) {
      const now = await Expense.findById(expense._id).select("source").lean();
      if (!now?.source?.deliveredAt) {
        throw new AppError(
          "UNAVAILABLE",
          `${expense.expenseNumber} has been recorded, but HRMS could not be told (${(err as Error).message}). ` +
            "Approve it again to resend — no second expense is made.",
        );
      }
    }
    await Expense.updateOne({ _id: expense._id, "source.deliveredAt": { $exists: false } }, { $set: { "source.deliveredAt": new Date() } });
  }
  // The sidebar's count asks HRMS again rather than showing it still waiting.
  forgetReimbursements(input.hrmsOrgId);
  return { expense: { id: String(expense._id), expenseNumber: expense.expenseNumber, totalMinor: expense.totalMinor, currency: expense.currency } };
}

export async function reject(orgId: string, userId: string, id: string, input: RejectReimbursementInput) {
  const row = await requireRow(orgId, input.hrmsOrgId, id);
  const made = await Expense.findOne({ organizationId: orgId, "source.key": sourceKey(input.hrmsOrgId, row._id), status: { $ne: "voided" } })
    .select("expenseNumber").lean();
  if (made) {
    throw new AppError(
      "CONFLICT",
      `${made.expenseNumber} has already been recorded for this claim. Approve it again to finish telling HRMS, or void ${made.expenseNumber} before refusing.`,
    );
  }
  const user = await User.findById(userId).select("name").lean();
  await hrmsClient.rejectReimbursement(input.hrmsOrgId, id, { note: input.note, by: user?.name ?? undefined });
  forgetReimbursements(input.hrmsOrgId);
  return { rejected: true };
}
