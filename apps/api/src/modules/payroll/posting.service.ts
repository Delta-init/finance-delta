import { Types } from "mongoose";
import { logger } from "../../lib/logger";
import { Expense } from "../expense/expense.model";
import { EXPENSE_DEFAULTS } from "@delta/shared";
import { resolveExpenseCategory } from "../expense-category/expense-category.service";
import { nextNumber } from "../sequence/sequence.service";
import type { PayrollRunDoc } from "./payroll-run.model";

const oid = (id: string) => new Types.ObjectId(id);

/**
 * Getting payroll into the profit and loss.
 *
 * There is no general ledger in this codebase — the architecture doc describes
 * a posting engine, but only the invoice model and the db-init script even
 * mention journals. The reports read documents directly, and the P&L sums
 * `Expense`. So a payroll run that posts nothing appears nowhere in the
 * accounts: the bank balance drops and no report explains why, which is a large
 * hole to leave in a system whose whole job is explaining where money went.
 *
 * The Expense document is written directly rather than through
 * `expense.service.createExpense`, which looks up
 * `User.findOne({ _id, organizationId })` — a field the User schema does not
 * have, since organizations live on `memberships[]`. That lookup can never
 * match, so the service always throws "User not found". Depending on it here
 * would make payroll fail for a reason that has nothing to do with payroll.
 */

/**
 * Post one payment as an expense.
 *
 * Never throws. The money has already moved by the time this runs, and failing
 * the payment because a bookkeeping entry could not be written would tell the
 * caller a transfer failed that did not. A missing expense is visible and
 * fixable; a payment the caller repeats is not.
 */
export async function postPayrollExpense(
  orgId: string,
  run: PayrollRunDoc,
  paymentId: string,
  actor: { userId: string; name: string },
): Promise<string | null> {
  const payment = run.payments.find((p) => p.paymentId === paymentId);
  if (!payment) return null;
  if (payment.expenseId) return String(payment.expenseId);

  try {
    // Payroll & Employee Benefits › Basic Salary (2026-10-21; was "Salaries & Wages"), added to the org if missing.
    const cat = await resolveExpenseCategory(orgId, EXPENSE_DEFAULTS.payroll.category, EXPENSE_DEFAULTS.payroll.subcategory);
    const expenseNumber = await nextNumber(orgId, "expense", "EXP-");

    const doc = await Expense.create({
      organizationId: oid(orgId),
      expenseNumber,
      category: cat.category,
      categoryName: cat.categoryName,
      subcategory: cat.subcategory,
      subcategoryName: cat.subcategoryName,
      description: `Payroll ${run.runNumber} · ${run.period} · ${payment.allocations.length} people`,
      expenseDate: payment.paidOn,
      amountMinor: payment.amountMinor,
      // Payroll carries no input tax to reclaim, so gross equals net here.
      taxPct: 0,
      taxMinor: 0,
      totalMinor: payment.amountMinor,
      currency: run.currency,
      paymentAccount: payment.bankAccountName,
      paymentMethod: payment.method,
      reference: payment.reference || payment.paymentId,
      submittedById: oid(actor.userId),
      submittedByName: actor.name,
      // Approved on arrival: the money is already gone, so an expense sitting in
      // draft would keep it out of the P&L exactly when it belongs there.
      status: "approved",
      approvedById: oid(actor.userId),
      approvedByName: actor.name,
      approvedAt: new Date(),
      notes: `Posted automatically from payroll run ${run.runNumber}.`,
    });

    payment.expenseId = doc._id;
    return String(doc._id);
  } catch (err) {
    logger.error(`Payroll ${run.runNumber} payment ${paymentId} could not be posted to expenses: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Void the expense behind a reversed payment.
 *
 * Voided rather than deleted, so the P&L for a closed period does not silently
 * change shape and somebody comparing two printouts can see what happened.
 */
export async function voidPayrollExpense(orgId: string, expenseId: string, reason: string): Promise<void> {
  await Expense.updateOne(
    { _id: oid(expenseId), organizationId: oid(orgId) },
    { $set: { status: "voided", rejectedReason: `Payroll payment reversed: ${reason}`.slice(0, 300) } },
  );
}
