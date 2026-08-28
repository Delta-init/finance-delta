import { Types } from "mongoose";
import { AppError } from "../../lib/http";
import { logger } from "../../lib/logger";
import { hrmsClient } from "../../lib/hrms-client";
import { BankAccount } from "../banking/bank-account.model";
import { BankTransaction } from "../banking/bank-transaction.model";
import { CommissionRecord } from "../commission/commission-record.model";
import { User } from "../user/user.model";
import { PayrollRun, type PayrollRunDoc } from "./payroll-run.model";
import { formatMinor } from "./money";
import { recalculate, type RecalcRun } from "./recalculate";
import { selectPayableLines, type PayableLine } from "./select-payable";
import { postPayrollExpense, voidPayrollExpense } from "./posting.service";

const oid = (id: string) => new Types.ObjectId(id);

/**
 * Step three: paying the run.
 *
 * The whole design turns on one asymmetry. Everything before this is
 * reversible bookkeeping; this moves real money, and the moment it does, the
 * two systems can disagree in a way that matters. So the order is fixed —
 * money first, then tell HRMS — and the gap between them is made visible rather
 * than papered over.
 */

async function loadRun(orgId: string, runId: string) {
  const run = await PayrollRun.findOne({ _id: oid(runId), organizationId: oid(orgId) });
  if (!run) throw new AppError("NOT_FOUND", "Payroll run not found");
  return run;
}

/** Sign the run off, and tell HRMS it is final. */
export async function approveRun(orgId: string, runId: string, actor: { userId: string }) {
  const run = await loadRun(orgId, runId);
  if (run.status === "approved") return { runNumber: run.runNumber, status: run.status, message: "Already approved" };
  if (run.status !== "imported" && run.status !== "additions") {
    throw new AppError("CONFLICT", `${run.runNumber} is ${run.status.replace("_", " ")} and cannot be approved.`);
  }

  const unsynced = run.adjustments.filter((a) => !a.syncedAt);
  if (unsynced.length) {
    // An adjustment HRMS never took is money on this side that no payslip
    // knows about. Approving over it would carry the discrepancy into payment.
    throw new AppError(
      "CONFLICT",
      `${unsynced.length} adjustment(s) were never confirmed by HRMS. Remove or re-apply them before approving.`,
    );
  }

  await hrmsClient.approveBatch(run.hrmsOrgId, run.period);

  run.status = "approved";
  run.approvedById = oid(actor.userId);
  run.approvedAt = new Date();
  await run.save();
  return { runNumber: run.runNumber, status: run.status, message: `${run.runNumber} approved for payment` };
}

/** Hand the month back to HR, with a reason they can act on. */
export async function returnRun(orgId: string, runId: string, reason: string) {
  const run = await loadRun(orgId, runId);
  if (run.amountPaidMinor > 0) {
    throw new AppError("CONFLICT", "Part of this run has already been paid and cannot be sent back.");
  }
  await hrmsClient.returnBatch(run.hrmsOrgId, run.period, reason);
  run.status = "returned";
  run.returnedReason = reason;
  await run.save();
  return { runNumber: run.runNumber, status: run.status, message: `${run.runNumber} sent back to HR` };
}

export interface PayInput {
  /** Which people this transfer covers. Empty means everybody still owed. */
  lineIds?: string[];
  bankAccountId: string;
  method: "bank_transfer" | "cash" | "cheque" | "card" | "online";
  paidOn: string;
  reference?: string;
}

/**
 * Pay some or all of a run.
 *
 * One bulk transfer covering many salaries and a single transfer for one person
 * are the same operation here, differing only in how many lines are named. That
 * is deliberate: paying one person separately is normal — a corrected salary, a
 * late joiner — and modelling it as an exception would mean two code paths that
 * settle money.
 */
export async function payRun(orgId: string, runId: string, input: PayInput, actor: { userId: string }) {
  const run = await loadRun(orgId, runId);
  if (run.status !== "approved" && run.status !== "partially_paid") {
    throw new AppError(
      "CONFLICT",
      `${run.runNumber} is ${run.status.replace("_", " ")}. Approve it before paying.`,
    );
  }

  const account = await BankAccount.findOne({ _id: oid(input.bankAccountId), organizationId: oid(orgId) });
  if (!account) throw new AppError("NOT_FOUND", "Bank account not found");
  if (account.currency !== run.currency) {
    // Refused rather than converted. Paying an AED payroll from an INR account
    // needs a rate and a decision about who bears the difference, and guessing
    // either would be inventing a number.
    throw new AppError(
      "VALIDATION_ERROR",
      `This run is in ${run.currency} but that account is in ${account.currency}.`,
    );
  }

  const selection = selectPayableLines(run.lines as unknown as PayableLine[], input.lineIds);
  const { allocations, amountMinor } = selection;

  if (!allocations.length) {
    throw new AppError(
      "CONFLICT",
      selection.skipped.held > 0
        ? `Nobody selected can be paid — ${selection.skipped.held} person(s) are held for missing bank details.`
        : "There is nothing left to pay on this run.",
    );
  }

  const paidOn = new Date(input.paidOn);
  if (Number.isNaN(paidOn.getTime())) throw new AppError("VALIDATION_ERROR", "paidOn is not a valid date");

  const user = await User.findById(oid(actor.userId)).select("name").lean();
  const paymentId = `${run.runNumber}-P${run.payments.length + 1}`;

  // ── The money moves first ────────────────────────────────────────────────
  // Negative: a payroll is a debit. addTransaction infers direction from the
  // sign, and the balance moves with it.
  const transaction = await BankTransaction.create({
    organizationId: oid(orgId),
    accountId: account._id,
    accountName: account.accountName,
    currency: account.currency,
    date: paidOn,
    description: `Payroll ${run.runNumber} · ${run.period} · ${allocations.length} people`,
    reference: input.reference ?? paymentId,
    amountMinor: -amountMinor,
    type: "debit",
    runningBalanceMinor: (account.currentBalanceMinor ?? 0) - amountMinor,
    source: "manual",
    status: "matched",
    matches: [{ type: "payroll", referenceId: String(run._id), referenceNumber: run.runNumber, amountMinor }],
  });
  await BankAccount.updateOne(
    { _id: account._id },
    { $set: { currentBalanceMinor: (account.currentBalanceMinor ?? 0) - amountMinor } },
  );

  for (const alloc of allocations) {
    const line = run.lines.find((l) => String(l._id) === String(alloc.lineId))!;
    line.amountPaidMinor += alloc.amountMinor;
    line.status = line.amountPaidMinor >= line.payableMinor ? "paid" : "partially_paid";
  }
  run.amountPaidMinor += amountMinor;
  recalculate(run as unknown as RecalcRun);

  run.payments.push({
    paymentId,
    method: input.method,
    paidOn,
    reference: input.reference ?? "",
    bankAccountId: account._id,
    bankAccountName: account.accountName,
    bankTransactionId: transaction._id,
    amountMinor,
    allocations,
    syncedToHrms: false,
    syncAttempts: 0,
    createdById: oid(actor.userId),
    createdByName: user?.name ?? "",
  } as never);

  const anyOutstanding = run.lines.some((l) => l.status !== "paid" && l.status !== "on_hold");
  const held = run.lines.filter((l) => l.status === "on_hold").length;
  run.status = anyOutstanding || held > 0 ? "partially_paid" : "paid";
  if (run.status === "paid") run.paidAt = new Date();
  await run.save();

  // ── Then everything that follows from it ─────────────────────────────────
  const sync = await syncPaymentToHrms(run, paymentId);
  const commissions = await settleCommissions(orgId, run, allocations.map((a) => String(a.lineId)));
  // Without this the bank balance drops and no report explains why.
  const expenseId = await postPayrollExpense(orgId, run, paymentId, { userId: actor.userId, name: user?.name ?? "" });
  await run.save();

  return {
    paymentId,
    runNumber: run.runNumber,
    status: run.status,
    paidCount: allocations.length,
    amountMinor,
    amountFormatted: formatMinor(amountMinor, run.currency),
    bankTransactionId: String(transaction._id),
    expenseId,
    commissionsSettled: commissions,
    heldCount: held,
    synced: sync.ok,
    warning: sync.ok ? null : sync.message,
  };
}

/**
 * Tell HRMS a payment happened, and record honestly whether it worked.
 *
 * Never throws. The money has already gone by the time this runs, so failing
 * the whole request would tell the caller the payment failed when it did not,
 * and they would very likely do it again. Instead the payment is flagged
 * unsynced, and retrying is a separate, safe action.
 */
async function syncPaymentToHrms(run: PayrollRunDoc, paymentId: string): Promise<{ ok: boolean; message: string }> {
  const payment = run.payments.find((p) => p.paymentId === paymentId);
  if (!payment) return { ok: false, message: "Payment not found on this run" };

  const lines = payment.allocations.map((a) => {
    const line = run.lines.find((l) => String(l._id) === String(a.lineId))!;
    return { payslipId: line.hrmsPayslipId, amount: a.amountMinor / 100 };
  });

  payment.syncAttempts += 1;
  payment.lastSyncAttemptAt = new Date();

  try {
    await hrmsClient.recordPayment(run.hrmsOrgId, run.period, {
      paymentId,
      paidOn: payment.paidOn.toISOString(),
      reference: payment.reference,
      method: payment.method,
      lines,
    });
    payment.syncedToHrms = true;
    payment.syncError = "";
    return { ok: true, message: "" };
  } catch (err) {
    payment.syncedToHrms = false;
    payment.syncError = (err as Error).message.slice(0, 500);
    logger.error(`Payroll ${run.runNumber} payment ${paymentId} paid but not synced to HRMS: ${payment.syncError}`);
    return {
      ok: false,
      message:
        `The money was transferred and recorded here, but HRMS could not be told: ${payment.syncError} ` +
        `Employees will still see their payslips as issued until this is retried. Nothing will be paid twice.`,
    };
  }
}

/** Retry a payment HRMS never acknowledged. Safe to call repeatedly. */
export async function retrySync(orgId: string, runId: string, paymentId: string) {
  const run = await loadRun(orgId, runId);
  const payment = run.payments.find((p) => p.paymentId === paymentId);
  if (!payment) throw new AppError("NOT_FOUND", "No such payment on this run");
  if (payment.syncedToHrms) return { paymentId, synced: true, message: "Already confirmed by HRMS" };

  const result = await syncPaymentToHrms(run, paymentId);
  await run.save();
  return { paymentId, synced: result.ok, message: result.ok ? "HRMS confirmed the payment" : result.message };
}

/**
 * Close off the commission that this payment actually paid.
 *
 * Done here rather than when commission was pulled onto the run, because until
 * the transfer happens the money is still owed. Marking it paid at pull time
 * would have the commission report showing settled amounts that are sitting in
 * a run nobody has transferred.
 */
async function settleCommissions(orgId: string, run: PayrollRunDoc, paidLineIds: string[]): Promise<number> {
  const ids = run.adjustments
    .filter((a) => a.source === "commission" && paidLineIds.includes(String(a.lineId)))
    .flatMap((a) => a.commissionRecordIds);
  if (!ids.length) return 0;

  const result = await CommissionRecord.updateMany(
    { _id: { $in: ids }, organizationId: oid(orgId), status: "earned" },
    { $set: { status: "paid", paidAt: new Date(), notes: `Paid through payroll ${run.runNumber}` } },
  );
  return result.modifiedCount;
}


/**
 * Reverse a payment, when a transfer bounced or was sent in error.
 *
 * Four things have to come undone together: the money, the payslips, the
 * commission that was closed off, and the expense that hit the P&L. Any one of
 * them left behind is a quiet inconsistency nobody would go looking for.
 *
 * The bank side is corrected with an opposite entry rather than by deleting the
 * debit. A deleted transaction leaves a reconciled statement that no longer
 * matches, and hides that the money went out at all.
 */
export async function reversePayment(
  orgId: string,
  runId: string,
  paymentId: string,
  reason: string,
) {
  const run = await loadRun(orgId, runId);
  const payment = run.payments.find((p) => p.paymentId === paymentId);
  if (!payment) throw new AppError("NOT_FOUND", "No such payment on this run");
  if (payment.reversedAt) {
    return { paymentId, message: "That payment was already reversed", alreadyReversed: true };
  }

  // HRMS first, and only if it ever knew. Reversing here while the payslips
  // still say paid would leave the employee's record claiming money that came
  // back — the exact disagreement this whole handover exists to prevent.
  if (payment.syncedToHrms) {
    await hrmsClient.reversePayment(run.hrmsOrgId, run.period, paymentId, reason);
  }

  const account = payment.bankAccountId
    ? await BankAccount.findOne({ _id: payment.bankAccountId, organizationId: oid(orgId) })
    : null;

  let reversalTxId: Types.ObjectId | null = null;
  if (account) {
    const tx = await BankTransaction.create({
      organizationId: oid(orgId),
      accountId: account._id,
      accountName: account.accountName,
      currency: account.currency,
      date: new Date(),
      description: `Reversal of payroll ${run.runNumber} payment ${paymentId}`,
      reference: payment.reference || paymentId,
      amountMinor: payment.amountMinor,
      type: "credit",
      runningBalanceMinor: (account.currentBalanceMinor ?? 0) + payment.amountMinor,
      source: "manual",
      status: "matched",
      matches: [{ type: "payroll", referenceId: String(run._id), referenceNumber: run.runNumber, amountMinor: payment.amountMinor }],
      notes: reason.slice(0, 500),
    });
    reversalTxId = tx._id;
    await BankAccount.updateOne(
      { _id: account._id },
      { $set: { currentBalanceMinor: (account.currentBalanceMinor ?? 0) + payment.amountMinor } },
    );
  }

  for (const alloc of payment.allocations) {
    const line = run.lines.find((l) => String(l._id) === String(alloc.lineId));
    if (!line) continue;
    line.amountPaidMinor = Math.max(0, line.amountPaidMinor - alloc.amountMinor);
    // Held people keep their hold: the reason they could not be paid has not
    // changed just because somebody else's transfer came back.
    if (line.status !== "on_hold") {
      line.status = line.amountPaidMinor <= 0 ? "pending" : "partially_paid";
    }
  }
  run.amountPaidMinor = Math.max(0, run.amountPaidMinor - payment.amountMinor);

  const unsettled = await unsettleCommissions(orgId, run, payment.allocations.map((a) => String(a.lineId)));
  if (payment.expenseId) await voidPayrollExpense(orgId, String(payment.expenseId), reason);

  payment.reversedAt = new Date();
  payment.reversalReason = reason;
  payment.reversalTransactionId = reversalTxId;

  recalculate(run as unknown as RecalcRun);
  const anyPaid = run.lines.some((l) => l.amountPaidMinor > 0);
  const allSettled = run.lines.every((l) => l.status === "paid" || l.status === "on_hold");
  run.status = allSettled ? "paid" : anyPaid ? "partially_paid" : "approved";
  if (run.status !== "paid") run.paidAt = null;
  await run.save();

  return {
    paymentId,
    alreadyReversed: false,
    message: `${formatMinor(payment.amountMinor, run.currency)} reversed across ${payment.allocations.length} people`,
    status: run.status,
    commissionsReopened: unsettled,
    bankTransactionId: reversalTxId ? String(reversalTxId) : null,
  };
}

/** Put commission back to earned when the payroll that paid it was reversed. */
async function unsettleCommissions(orgId: string, run: PayrollRunDoc, lineIds: string[]): Promise<number> {
  const ids = run.adjustments
    .filter((a) => a.source === "commission" && lineIds.includes(String(a.lineId)))
    .flatMap((a) => a.commissionRecordIds);
  if (!ids.length) return 0;

  const result = await CommissionRecord.updateMany(
    { _id: { $in: ids }, organizationId: oid(orgId), status: "paid" },
    { $set: { status: "earned", paidAt: null, notes: `Payroll ${run.runNumber} payment reversed` } },
  );
  return result.modifiedCount;
}
