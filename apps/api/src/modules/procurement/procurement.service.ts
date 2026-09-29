import { Types } from "mongoose";
import type { ApproveProcurementInput, RejectProcurementInput } from "@delta/shared";
import { computeExpenseTax, resolveCategoryName } from "@delta/shared";
import { PayrollOrgLink } from "../payroll-mapping/org-link.model";
import { PayrollDeptLink } from "../payroll-mapping/dept-link.model";
import { hrmsClient, type HrmsProcurementRequest } from "../../lib/hrms-client";
import { Expense } from "../expense/expense.model";
import { categoryNameMap } from "../expense-category/expense-category.service";
import { Department } from "../department/department.model";
import { User } from "../user/user.model";
import { nextNumber } from "../sequence/sequence.service";
import { AppError } from "../../lib/http";
import { forgetProcurementRequests } from "../approvals/approvals.service";

/**
 * Purchase requests HR has approved, and the money decision on them.
 *
 * Nothing is mirrored here. The request belongs to HRMS and is read live, the
 * same way payroll batches are — a local copy would be one more thing to keep
 * in step, and the only question finance actually answers is yes or no.
 *
 * A yes is recorded as an expense, approved and unpaid: the company has
 * agreed to spend the money, and "Mark paid" says when it went. It used to
 * raise a purchase order, which meant choosing a vendor from the vendor list
 * for every chair and toner cartridge — nobody ever did, and nothing was ever
 * approved. The expense is finance's own record; the request stays HRMS's.
 */

/** The HRMS organisations this finance org is linked to. */
async function linkedOrgIds(orgId: string): Promise<string[]> {
  const links = await PayrollOrgLink.find({ organizationId: new Types.ObjectId(orgId) }).select("hrmsOrgId").lean();
  return links.map((l) => String(l.hrmsOrgId));
}

/**
 * Names the decision an expense stands for: this request, on this round.
 *
 * The round is HRMS's resubmit count. A request finance rejects can be revised
 * and come back, and deciding it again is a new decision — it must not find
 * the expense a different decision made.
 */
function sourceKey(hrmsOrgId: string, row: Pick<HrmsProcurementRequest, "_id" | "resubmitCount">): string {
  return `hrms:${hrmsOrgId}:${row._id}:${row.resubmitCount ?? 0}`;
}

export interface ProcurementRow extends HrmsProcurementRequest {
  /** Which HRMS organisation it came from — needed to send the answer back. */
  hrmsOrgId: string;
  /** The finance department HR's department is linked to, when it is. */
  suggestedDepartmentId: string | null;
  /**
   * An expense already made for this request, whose answer HRMS never took —
   * HRMS was down, or refused. Approving again sends it; it makes no other.
   */
  expense: { id: string; expenseNumber: string; status: string } | null;
}

/** Everything waiting on finance, across every linked HRMS organisation. */
export async function listWaiting(orgId: string): Promise<ProcurementRow[]> {
  if (!hrmsClient.isConfigured()) throw new AppError("CONFLICT", "The HRMS integration is not configured.");
  const hrmsOrgIds = await linkedOrgIds(orgId);
  const rows: Array<HrmsProcurementRequest & { hrmsOrgId: string }> = [];
  for (const hrmsOrgId of hrmsOrgIds) {
    rows.push(...(await hrmsClient.procurementRequests(hrmsOrgId)).map((r) => ({ ...r, hrmsOrgId })));
  }

  const [deptLinks, made] = await Promise.all([
    PayrollDeptLink.find({ organizationId: new Types.ObjectId(orgId), hrmsOrgId: { $in: hrmsOrgIds }, isActive: { $ne: false } })
      .select("hrmsOrgId hrmsDepartmentId departmentId").lean(),
    rows.length
      ? Expense.find({ organizationId: new Types.ObjectId(orgId), "source.key": { $in: rows.map((r) => sourceKey(r.hrmsOrgId, r)) } })
        .select("expenseNumber status source").lean()
      : [],
  ]);
  const deptFor = new Map(deptLinks.map((l) => [`${l.hrmsOrgId}:${l.hrmsDepartmentId}`, String(l.departmentId)]));
  const madeFor = new Map(made.map((e) => [String(e.source?.key), e]));

  return rows
    .map((r) => {
      const e = madeFor.get(sourceKey(r.hrmsOrgId, r));
      return {
        ...r,
        suggestedDepartmentId: r.department?._id ? deptFor.get(`${r.hrmsOrgId}:${r.department._id}`) ?? null : null,
        expense: e ? { id: String(e._id), expenseNumber: String(e.expenseNumber), status: String(e.status) } : null,
      };
    })
    // Soonest needed first; a request with no date sorts last rather than first.
    .sort((a, b) => (a.neededBy ?? "9999").localeCompare(b.neededBy ?? "9999"));
}

async function requireRow(orgId: string, hrmsOrgId: string, requestId: string): Promise<HrmsProcurementRequest> {
  if (!(await linkedOrgIds(orgId)).includes(hrmsOrgId)) {
    throw new AppError("FORBIDDEN", "That organisation is not linked to this one.");
  }
  const row = (await hrmsClient.procurementRequests(hrmsOrgId)).find((r) => r._id === requestId);
  if (!row) throw new AppError("NOT_FOUND", "That request is no longer waiting for a decision.");
  return row;
}

/** What HR wrote, kept on the expense so nobody has to open HRMS to know what it was for. */
function notesFor(row: HrmsProcurementRequest, amountMinor: number, note: string, currency: string): string {
  const estimateMinor = Math.round((row.estimatedCost || 0) * 100);
  return [
    "Purchase request approved from HRMS.",
    row.requestedBy?.name ? `Asked by: ${row.requestedBy.name}` : "",
    row.department?.name ? `HRMS department: ${row.department.name}` : "",
    row.justification ? `Why: ${row.justification}` : "",
    row.vendor ? `Suggested vendor: ${row.vendor}` : "",
    estimateMinor !== amountMinor ? `HR's estimate: ${currency} ${(estimateMinor / 100).toFixed(2)}` : "",
    row.hrNote ? `HR note: ${row.hrNote}` : "",
    note ? `Finance note: ${note}` : "",
  ].filter(Boolean).join("\n");
}

/**
 * The expense an approval records. Made once per request and round: the link
 * to the request is written in the same insert, and its key is unique, so two
 * approvers pressing at once end up holding the same expense.
 */
async function makeExpense(
  orgId: string,
  userId: string,
  hrmsOrgId: string,
  row: HrmsProcurementRequest,
  input: ApproveProcurementInput,
) {
  const key = sourceKey(hrmsOrgId, row);
  const { amountMinor, category } = input;
  if (!amountMinor) throw new AppError("VALIDATION_ERROR", "Enter the amount being approved.");
  if (!category) throw new AppError("VALIDATION_ERROR", "Choose an expense category.");
  const user = await User.findById(userId).select("name").lean();
  if (!user) throw new AppError("NOT_FOUND", "User not found");

  const categoryName = (await categoryNameMap(orgId)).get(category);
  if (!categoryName) throw new AppError("VALIDATION_ERROR", `Unknown expense category "${category}"`);
  if (input.departmentId && !(await Department.exists({ _id: input.departmentId, organizationId: orgId }))) {
    throw new AppError("VALIDATION_ERROR", "That department is not in this organization.");
  }
  const currency = (row.currency || "AED").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new AppError("VALIDATION_ERROR", `HR's currency "${row.currency}" is not a currency code.`);
  }

  // HR's figure carries no tax split; the expense can be corrected when it is paid.
  const { netMinor, taxMinor, totalMinor } = computeExpenseTax(amountMinor, 0, false);
  const quantity = Math.max(1, row.quantity || 1);
  const now = new Date();
  // The unique key on the request is what makes a second approval harmless, and
  // Mongoose builds it in the background after start-up. Wait for it (a no-op
  // once built), so the first approvals after a deploy cannot slip in twice.
  await Expense.init();
  const expenseNumber = await nextNumber(orgId, "expense", "EXP-");
  try {
    return await Expense.create({
      organizationId: new Types.ObjectId(orgId),
      expenseNumber,
      category,
      categoryName: resolveCategoryName(category, categoryName, input.categoryOther),
      description: `${quantity} × ${row.item}`,
      // Dated the way a typed-in expense is — the day, at midnight UTC — which
      // is what the Expenses list's date filter compares against.
      expenseDate: new Date(now.toISOString().slice(0, 10)),
      amountMinor: netMinor,
      taxPct: 0,
      taxInclusive: false,
      taxMinor,
      totalMinor,
      currency,
      // "Needed by" is the date it has to be bought by — which is when it falls due.
      dueDate: row.neededBy ? new Date(row.neededBy) : undefined,
      submittedById: new Types.ObjectId(userId),
      submittedByName: user.name,
      // The approval on this page is the approval: it is not sent round again.
      status: "approved",
      approvedById: new Types.ObjectId(userId),
      approvedByName: user.name,
      approvedAt: now,
      departmentId: input.departmentId ? new Types.ObjectId(input.departmentId) : undefined,
      notes: notesFor(row, amountMinor, input.note, currency),
      source: { kind: "hrms_procurement", key, hrmsOrgId, requestId: row._id, round: row.resubmitCount ?? 0 },
    });
  } catch (err) {
    // Somebody else's approval made it a moment ago — theirs is the one. (The
    // number this one drew goes unused: two approvers at the same instant are
    // rare enough that a gap in the sequence is the better price.)
    if ((err as { code?: number }).code === 11000) {
      const theirs = await Expense.findOne({ "source.key": key });
      if (theirs) return theirs;
    }
    throw err;
  }
}

/**
 * Approve one, recording the expense it becomes.
 *
 * The expense is made first. If HRMS cannot be told afterwards, the expense
 * exists and the request stays waiting, marked with it — approving again only
 * resends the answer. The other order leaves HR told it was approved with
 * nothing recorded here, and no sign anything is missing.
 */
export async function approve(orgId: string, userId: string, requestId: string, input: ApproveProcurementInput) {
  const row = await requireRow(orgId, input.hrmsOrgId, requestId);

  let expense = await Expense.findOne({ organizationId: orgId, "source.key": sourceKey(input.hrmsOrgId, row) });
  if (expense?.status === "voided") {
    throw new AppError(
      "CONFLICT",
      `${expense.expenseNumber} was made for this request and then voided. Reject the request instead — HR can revise it and send it back.`,
    );
  }
  // An expense from an earlier attempt stands as it was made: this is a resend.
  expense ??= await makeExpense(orgId, userId, input.hrmsOrgId, row, input);

  if (!expense.source?.deliveredAt) {
    try {
      await hrmsClient.approveProcurement(input.hrmsOrgId, requestId, {
        purchaseOrderRef: expense.expenseNumber,
        note: input.note || undefined,
      });
    } catch (err) {
      // A second approver's send may have got there first.
      const now = await Expense.findById(expense._id).select("source").lean();
      if (!now?.source?.deliveredAt) {
        throw new AppError(
          "UNAVAILABLE",
          `${expense.expenseNumber} has been recorded, but HRMS could not be told (${(err as Error).message}). ` +
            "Approve it again to resend — no second expense is made.",
        );
      }
    }
    await Expense.updateOne(
      { _id: expense._id, "source.deliveredAt": { $exists: false } },
      { $set: { "source.deliveredAt": new Date() } },
    );
  }
  forgetProcurementRequests(input.hrmsOrgId);

  return { expense: { id: String(expense._id), expenseNumber: expense.expenseNumber, totalMinor: expense.totalMinor, currency: expense.currency } };
}

export async function reject(orgId: string, requestId: string, input: RejectProcurementInput) {
  const row = await requireRow(orgId, input.hrmsOrgId, requestId);
  // Refusing what an expense already stands for would leave HR told "no" and the books saying "yes".
  const made = await Expense.findOne({
    organizationId: orgId,
    "source.key": sourceKey(input.hrmsOrgId, row),
    status: { $ne: "voided" },
  }).select("expenseNumber").lean();
  if (made) {
    throw new AppError(
      "CONFLICT",
      `${made.expenseNumber} has already been recorded for this request. Approve it again to finish telling HR, or void ${made.expenseNumber} before rejecting.`,
    );
  }
  await hrmsClient.rejectProcurement(input.hrmsOrgId, requestId, { note: input.note || undefined });
  forgetProcurementRequests(input.hrmsOrgId);
  return { rejected: true };
}
