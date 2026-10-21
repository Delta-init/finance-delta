import { Types } from "mongoose";
import type { MarkOneTimePaidInput, RejectOneTimePaymentInput } from "@delta/shared";
import { EXPENSE_DEFAULTS, computeExpenseTax, resolveCategoryName } from "@delta/shared";
import { PayrollOrgLink } from "../payroll-mapping/org-link.model";
import { PayrollDeptLink } from "../payroll-mapping/dept-link.model";
import { hrmsClient, type HrmsOneTimePayment } from "../../lib/hrms-client";
import { Expense } from "../expense/expense.model";
import { placeExpenseInBank } from "../expense/expense.service";
import { resolveExpenseCategory } from "../expense-category/expense-category.service";
import { Department } from "../department/department.model";
import { User } from "../user/user.model";
import { nextNumber } from "../sequence/sequence.service";
import { AppError } from "../../lib/http";

/**
 * One-time payments from HRMS — a bonus or commission HR sent for finance to
 * pay directly, rather than putting it on a payslip.
 *
 * The same shape as salary advances: read live from HRMS, nothing mirrored.
 * "Mark paid" records a paid expense first and then tells HRMS, so if HRMS
 * cannot be told, marking it again only resends — no second expense.
 */

async function linkedOrgIds(orgId: string): Promise<string[]> {
  const links = await PayrollOrgLink.find({ organizationId: new Types.ObjectId(orgId) }).select("hrmsOrgId").lean();
  return links.map((l) => String(l.hrmsOrgId));
}

/** One expense per payment — it is decided once. */
function sourceKey(hrmsOrgId: string, id: string): string {
  return `hrms-one-time:${hrmsOrgId}:${id}`;
}

export interface OneTimePaymentRow extends HrmsOneTimePayment {
  hrmsOrgId: string;
  suggestedDepartmentId: string | null;
  expense: { id: string; expenseNumber: string; status: string } | null;
}

export async function listWaiting(orgId: string): Promise<OneTimePaymentRow[]> {
  if (!hrmsClient.isConfigured()) throw new AppError("CONFLICT", "The HRMS integration is not configured.");
  const hrmsOrgIds = await linkedOrgIds(orgId);
  const rows: Array<HrmsOneTimePayment & { hrmsOrgId: string }> = [];
  for (const hrmsOrgId of hrmsOrgIds) {
    rows.push(...(await hrmsClient.oneTimePayments(hrmsOrgId)).map((r) => ({ ...r, hrmsOrgId })));
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
        expense: e ? { id: String(e._id), expenseNumber: String(e.expenseNumber), status: String(e.status) } : null,
      };
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

async function requireRow(orgId: string, hrmsOrgId: string, id: string): Promise<HrmsOneTimePayment> {
  if (!(await linkedOrgIds(orgId)).includes(hrmsOrgId)) throw new AppError("FORBIDDEN", "That organisation is not linked to this one.");
  const row = (await hrmsClient.oneTimePayments(hrmsOrgId)).find((r) => r._id === id);
  if (!row) throw new AppError("NOT_FOUND", "That payment is no longer waiting on finance.");
  return row;
}

function notesFor(row: HrmsOneTimePayment, note: string): string {
  return [
    "One-time payment from HRMS (not on the payslip).",
    row.employee?.name ? `Employee: ${row.employee.name}${row.employee.employeeCode ? ` (${row.employee.employeeCode})` : ""}` : "",
    `For: ${row.label} · ${row.month}`,
    row.notes ? `HR note: ${row.notes}` : "",
    row.createdBy?.name ? `Raised in HR by ${row.createdBy.name}` : "",
    note ? `Finance note: ${note}` : "",
  ].filter(Boolean).join("\n");
}

async function makeExpense(orgId: string, userId: string, hrmsOrgId: string, row: HrmsOneTimePayment, input: MarkOneTimePaidInput) {
  const key = sourceKey(hrmsOrgId, row._id);
  if (!input.category) throw new AppError("VALIDATION_ERROR", "Choose an expense category.");
  const user = await User.findById(userId).select("name").lean();
  if (!user) throw new AppError("NOT_FOUND", "User not found");
  const cat = await resolveExpenseCategory(orgId, input.category, input.subcategory, { fallbackSub: EXPENSE_DEFAULTS.oneTimePayment.subcategory });
  if (input.departmentId && !(await Department.exists({ _id: input.departmentId, organizationId: orgId }))) {
    throw new AppError("VALIDATION_ERROR", "That department is not in this organization.");
  }
  const currency = (row.employee?.currency || "AED").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new AppError("VALIDATION_ERROR", `The employee's currency "${row.employee?.currency}" is not a currency code.`);
  const amountMinor = Math.round(row.amount * 100);
  if (!(amountMinor > 0)) throw new AppError("VALIDATION_ERROR", "This payment has no amount.");

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
      description: `${row.label} — ${row.employee?.name ?? "employee"}`,
      expenseDate: new Date(now.toISOString().slice(0, 10)),
      amountMinor: netMinor,
      taxPct: 0,
      taxInclusive: false,
      taxMinor,
      totalMinor,
      currency,
      submittedById: new Types.ObjectId(userId),
      submittedByName: user.name,
      status: "approved",
      approvedById: new Types.ObjectId(userId),
      approvedByName: user.name,
      approvedAt: now,
      paidOn: new Date(`${input.paidOn}T00:00:00.000Z`),
      paymentMethod: input.paymentMethod,
      reference: input.reference || "",
      departmentId: input.departmentId ? new Types.ObjectId(input.departmentId) : undefined,
      notes: notesFor(row, input.note),
      source: { kind: "hrms_one_time", key, hrmsOrgId, requestId: row._id, round: 0 },
    });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      const theirs = await Expense.findOne({ "source.key": key });
      if (theirs) return theirs;
    }
    throw err;
  }
}

export async function markPaid(orgId: string, userId: string, id: string, input: MarkOneTimePaidInput) {
  const row = await requireRow(orgId, input.hrmsOrgId, id);
  let expense = await Expense.findOne({ organizationId: orgId, "source.key": sourceKey(input.hrmsOrgId, row._id) });
  if (expense?.status === "voided") {
    throw new AppError("CONFLICT", `${expense.expenseNumber} was made for this payment and then voided. Reject the payment instead.`);
  }
  expense ??= await makeExpense(orgId, userId, input.hrmsOrgId, row, input);
  // In its method's bank account, as money out (2026-10-16).
  await placeExpenseInBank(orgId, expense._id);

  if (!expense.source?.deliveredAt) {
    try {
      await hrmsClient.markOneTimePaid(input.hrmsOrgId, id, {
        paidOn: expense.paidOn ? new Date(expense.paidOn).toISOString().slice(0, 10) : input.paidOn,
        method: expense.paymentMethod ?? input.paymentMethod,
        reference: expense.expenseNumber,
        note: input.note || undefined,
      });
    } catch (err) {
      const now = await Expense.findById(expense._id).select("source").lean();
      if (!now?.source?.deliveredAt) {
        throw new AppError(
          "UNAVAILABLE",
          `${expense.expenseNumber} has been recorded, but HRMS could not be told (${(err as Error).message}). ` +
            "Mark it paid again to resend — no second expense is made.",
        );
      }
    }
    await Expense.updateOne({ _id: expense._id, "source.deliveredAt": { $exists: false } }, { $set: { "source.deliveredAt": new Date() } });
  }
  return { expense: { id: String(expense._id), expenseNumber: expense.expenseNumber, totalMinor: expense.totalMinor, currency: expense.currency } };
}

export async function reject(orgId: string, id: string, input: RejectOneTimePaymentInput) {
  const row = await requireRow(orgId, input.hrmsOrgId, id);
  const made = await Expense.findOne({ organizationId: orgId, "source.key": sourceKey(input.hrmsOrgId, row._id), status: { $ne: "voided" } })
    .select("expenseNumber").lean();
  if (made) {
    throw new AppError(
      "CONFLICT",
      `${made.expenseNumber} has already been recorded for this payment. Mark it paid again to finish telling HRMS, or void ${made.expenseNumber} before rejecting.`,
    );
  }
  await hrmsClient.rejectOneTimePayment(input.hrmsOrgId, id, { note: input.note || undefined });
  return { rejected: true };
}
