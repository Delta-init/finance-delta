import { Types } from "mongoose";
import type { ApproveAdvanceInput, RejectAdvanceInput } from "@delta/shared";
import { computeExpenseTax, resolveCategoryName } from "@delta/shared";
import { PayrollOrgLink } from "../payroll-mapping/org-link.model";
import { PayrollDeptLink } from "../payroll-mapping/dept-link.model";
import { hrmsClient, type HrmsSalaryAdvance } from "../../lib/hrms-client";
import { Expense } from "../expense/expense.model";
import { categoryNameMap } from "../expense-category/expense-category.service";
import { Department } from "../department/department.model";
import { User } from "../user/user.model";
import { nextNumber } from "../sequence/sequence.service";
import { AppError } from "../../lib/http";
import { forgetSalaryAdvances } from "../approvals/approvals.service";

/**
 * Salary advances HR has approved in HRMS, and finance's decision on them.
 *
 * Built the way procurement is: nothing is mirrored, the request is read live
 * from HRMS, and "Mark paid" is recorded here as an expense — approved and
 * paid, on the date and by the method finance gives — before HRMS is told, so a lost answer can be resent without a second
 * expense. HRMS then recovers the advance from the employee's pay on the
 * schedule HR set; nothing about that schedule is decided here.
 */

/** The HRMS organisations this finance org is linked to. */
async function linkedOrgIds(orgId: string): Promise<string[]> {
  const links = await PayrollOrgLink.find({ organizationId: new Types.ObjectId(orgId) }).select("hrmsOrgId").lean();
  return links.map((l) => String(l.hrmsOrgId));
}

/** One expense per advance. An advance is decided once — there is no resubmit round. */
function sourceKey(hrmsOrgId: string, id: string): string {
  return `hrms-advance:${hrmsOrgId}:${id}`;
}

export interface AdvanceRow extends HrmsSalaryAdvance {
  hrmsOrgId: string;
  /** The finance department the employee's HRMS department is linked to, when it is. */
  suggestedDepartmentId: string | null;
  /** An expense already made for it, whose answer HRMS never took. */
  expense: { id: string; expenseNumber: string; status: string } | null;
}

/** Everything waiting on finance, across every linked HRMS organisation. */
export async function listWaiting(orgId: string): Promise<AdvanceRow[]> {
  if (!hrmsClient.isConfigured()) throw new AppError("CONFLICT", "The HRMS integration is not configured.");
  const hrmsOrgIds = await linkedOrgIds(orgId);
  const rows: Array<HrmsSalaryAdvance & { hrmsOrgId: string }> = [];
  for (const hrmsOrgId of hrmsOrgIds) {
    rows.push(...(await hrmsClient.salaryAdvances(hrmsOrgId)).map((r) => ({ ...r, hrmsOrgId })));
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
    // Soonest needed first; one with no date sorts last.
    .sort((a, b) => (a.neededBy ?? "9999").localeCompare(b.neededBy ?? "9999"));
}

async function requireRow(orgId: string, hrmsOrgId: string, id: string): Promise<HrmsSalaryAdvance> {
  if (!(await linkedOrgIds(orgId)).includes(hrmsOrgId)) {
    throw new AppError("FORBIDDEN", "That organisation is not linked to this one.");
  }
  const row = (await hrmsClient.salaryAdvances(hrmsOrgId)).find((r) => r._id === id);
  if (!row) throw new AppError("NOT_FOUND", "That advance is no longer waiting for a decision.");
  return row;
}

function notesFor(row: HrmsSalaryAdvance, note: string): string {
  const per = (row.amount / Math.max(1, row.months)).toFixed(2);
  return [
    "Salary advance approved from HRMS.",
    row.employee?.name ? `Employee: ${row.employee.name}${row.employee.employeeCode ? ` (${row.employee.employeeCode})` : ""}` : "",
    row.reason ? `Why: ${row.reason}` : "",
    `Recovered from pay: ${row.currency} ${per} a month × ${row.months}, from ${row.startMonth}.`,
    row.hrReviewedBy?.name ? `Approved in HR by ${row.hrReviewedBy.name}` : "",
    row.hrNote ? `HR note: ${row.hrNote}` : "",
    note ? `Finance note: ${note}` : "",
  ].filter(Boolean).join("\n");
}

async function makeExpense(orgId: string, userId: string, hrmsOrgId: string, row: HrmsSalaryAdvance, input: ApproveAdvanceInput) {
  const key = sourceKey(hrmsOrgId, row._id);
  const category = input.category;
  if (!category) throw new AppError("VALIDATION_ERROR", "Choose an expense category.");
  const user = await User.findById(userId).select("name").lean();
  if (!user) throw new AppError("NOT_FOUND", "User not found");
  const categoryName = (await categoryNameMap(orgId)).get(category);
  if (!categoryName) throw new AppError("VALIDATION_ERROR", `Unknown expense category "${category}"`);
  if (input.departmentId && !(await Department.exists({ _id: input.departmentId, organizationId: orgId }))) {
    throw new AppError("VALIDATION_ERROR", "That department is not in this organization.");
  }
  const currency = (row.currency || "AED").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new AppError("VALIDATION_ERROR", `HR's currency "${row.currency}" is not a currency code.`);
  const amountMinor = Math.round(row.amount * 100);
  if (!(amountMinor > 0)) throw new AppError("VALIDATION_ERROR", "This advance has no amount.");

  const { netMinor, taxMinor, totalMinor } = computeExpenseTax(amountMinor, 0, false);
  const now = new Date();
  await Expense.init();
  const expenseNumber = await nextNumber(orgId, "expense", "EXP-");
  try {
    return await Expense.create({
      organizationId: new Types.ObjectId(orgId),
      expenseNumber,
      category,
      categoryName: resolveCategoryName(category, categoryName, ""),
      description: `Salary advance — ${row.employee?.name ?? "employee"}`,
      expenseDate: new Date(now.toISOString().slice(0, 10)),
      amountMinor: netMinor,
      taxPct: 0,
      taxInclusive: false,
      taxMinor,
      totalMinor,
      currency,
      dueDate: row.neededBy ? new Date(row.neededBy) : undefined,
      submittedById: new Types.ObjectId(userId),
      submittedByName: user.name,
      status: "approved",
      approvedById: new Types.ObjectId(userId),
      approvedByName: user.name,
      approvedAt: now,
      // Marked paid here — this page records the money going, not a promise of it.
      paidOn: new Date(`${input.paidOn}T00:00:00.000Z`),
      paymentMethod: input.paymentMethod,
      reference: input.reference || "",
      departmentId: input.departmentId ? new Types.ObjectId(input.departmentId) : undefined,
      notes: notesFor(row, input.note),
      source: { kind: "hrms_advance", key, hrmsOrgId, requestId: row._id, round: 0 },
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
 * Approve one: record the payout as an expense, then tell HRMS, which starts
 * the recovery. Expense first — if HRMS cannot be told, approving again only
 * resends the answer.
 */
export async function approve(orgId: string, userId: string, id: string, input: ApproveAdvanceInput) {
  const row = await requireRow(orgId, input.hrmsOrgId, id);

  let expense = await Expense.findOne({ organizationId: orgId, "source.key": sourceKey(input.hrmsOrgId, row._id) });
  if (expense?.status === "voided") {
    throw new AppError("CONFLICT", `${expense.expenseNumber} was made for this advance and then voided. Reject the advance instead.`);
  }
  expense ??= await makeExpense(orgId, userId, input.hrmsOrgId, row, input);

  if (!expense.source?.deliveredAt) {
    try {
      await hrmsClient.approveAdvance(input.hrmsOrgId, id, {
        reference: expense.expenseNumber,
        note: input.note || undefined,
        // What the expense says, so the two systems agree even on a resend.
        paidOn: expense.paidOn ? new Date(expense.paidOn).toISOString().slice(0, 10) : input.paidOn,
        method: expense.paymentMethod ?? input.paymentMethod,
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
  // Approvals' count asks HRMS again rather than showing it still waiting.
  forgetSalaryAdvances(input.hrmsOrgId);

  return { expense: { id: String(expense._id), expenseNumber: expense.expenseNumber, totalMinor: expense.totalMinor, currency: expense.currency } };
}

export async function reject(orgId: string, id: string, input: RejectAdvanceInput) {
  const row = await requireRow(orgId, input.hrmsOrgId, id);
  const made = await Expense.findOne({
    organizationId: orgId,
    "source.key": sourceKey(input.hrmsOrgId, row._id),
    status: { $ne: "voided" },
  }).select("expenseNumber").lean();
  if (made) {
    throw new AppError(
      "CONFLICT",
      `${made.expenseNumber} has already been recorded for this advance. Approve it again to finish telling HRMS, or void ${made.expenseNumber} before rejecting.`,
    );
  }
  await hrmsClient.rejectAdvance(input.hrmsOrgId, id, { note: input.note || undefined });
  forgetSalaryAdvances(input.hrmsOrgId);
  return { rejected: true };
}
