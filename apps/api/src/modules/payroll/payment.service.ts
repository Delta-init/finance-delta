import { Types } from "mongoose";
import { CrmCommissionPayout } from "../crm-commission/crm-commission-payout.model";
import { CsCommissionPayout } from "../cs-commission/cs-commission-payout.model";
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
import { selectPayableLines, isSettled, type PayableLine } from "./select-payable";
import { currencyOf } from "./currency-totals";
import { postPayrollExpense, voidPayrollExpense } from "./posting.service";
import { notifyPaymentNotSynced } from "./notify.service";

const oid = (id: string) => new Types.ObjectId(id);

/** Whose pay a payment finished: its own record, or — from before people were paid in parts — everybody in it. */
const finishedBy = (p: { finishedLineIds?: Types.ObjectId[] | null; allocations: Array<{ lineId: unknown }> }) =>
  (p.finishedLineIds ?? p.allocations.map((a) => a.lineId)).map(String);

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

/**
 * Hold one person back from payment, or let them be paid again (2026-10-30:
 * somebody who has left, still on the month HRMS handed over). Only before
 * their money has gone: an unpaid line can be held, a held one released — one
 * held for missing bank details too (2026-11-05: they are paid by cash, or by
 * transfer once accounts have the details). Not on a run that is paid: what is
 * held there was settled as not owed.
 */
export async function setLineHold(
  orgId: string, runId: string, lineId: string, input: { hold: boolean; reason?: string }, actor: { userId: string },
) {
  const run = await loadRun(orgId, runId);
  if (!["imported", "additions", "approved", "partially_paid"].includes(run.status)) {
    throw new AppError("CONFLICT", `${run.runNumber} is ${run.status.replace("_", " ")} — nobody on it can be held or released now.`);
  }
  const line = run.lines.find((l) => String(l._id) === lineId);
  if (!line) throw new AppError("NOT_FOUND", "That person is not on this run");
  const who = (await User.findById(oid(actor.userId)).select("name").lean())?.name ?? "accounts";
  if (input.hold) {
    if (line.status !== "pending") {
      throw new AppError("CONFLICT", `${line.name} is ${line.status.replace("_", " ")} — only somebody not paid yet can be held.`);
    }
    line.status = "on_hold";
    line.holdReason = `${input.reason?.trim() || "Held by accounts"} (held by ${who})`;
  } else {
    if (line.status !== "on_hold") throw new AppError("CONFLICT", `${line.name} is not held.`);
    line.status = "pending";
    line.holdReason = "";
  }
  await run.save();
  return { lineId, status: line.status, holdReason: line.holdReason, message: input.hold ? `${line.name} held` : `${line.name} released — will be paid` };
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

/**
 * Undo an approval (the user, 2026-11-01: "approved by mistake — send it one step back"): the run goes back to where
 * it stood before it was signed off — Additions if it has any, else Imported — and HRMS has the month back with
 * accounts. Only while nothing of it is paid: after that, a payment is reversed instead. HRMS first, so the two never
 * disagree: refused there, nothing changes here.
 */
export async function unapproveRun(orgId: string, runId: string, reason: string) {
  const run = await loadRun(orgId, runId);
  if (run.status !== "approved") {
    throw new AppError("CONFLICT", `${run.runNumber} is ${run.status.replace("_", " ")} — only an approved run's approval can be undone.`);
  }
  if (run.amountPaidMinor > 0 || run.payments.length > 0) {
    throw new AppError("CONFLICT", `Part of ${run.runNumber} has already been paid — reverse that payment first.`);
  }
  await hrmsClient.unapproveBatch(run.hrmsOrgId, run.period, reason);
  run.status = run.adjustments.length > 0 ? "additions" : "imported";
  run.set("approvedById", undefined);
  run.set("approvedAt", undefined);
  await run.save();
  return { runNumber: run.runNumber, status: run.status, message: `${run.runNumber} is back before approval` };
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
  /** Or which people and how much each (2026-11-03: a person paid in parts, by more than one method). */
  amounts?: Array<{ lineId: string; amountMinor: number }>;
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

  // A payment is in its account's currency and covers only the people paid in
  // it. A month can hold salaries in dirhams and in rupees (October 2026: 81 and
  // 22), and an account pays out in one. Only the run's own currency used to be
  // checked, so a dirham account took every rupee salary too, as dirhams.
  // Converting instead needs a rate and a decision about who bears the
  // difference, and guessing either would be inventing a number, so rupees are
  // paid from a rupee account.
  const asked = input.amounts?.length ? new Map(input.amounts.map((a) => [a.lineId, a.amountMinor])) : undefined;
  const selection = selectPayableLines(run.lines as unknown as PayableLine[], input.lineIds, {
    currency: account.currency,
    fallback: run.currency,
  }, asked);
  const { allocations, amountMinor } = selection;

  // More than somebody is still owed: refused whole. Recording less than was asked would put a transfer in the books
  // of a size nobody made; recording more would pay them twice.
  if (selection.over.length) {
    const said = selection.over.map((o) => {
      const line = run.lines.find((l) => String(l._id) === String(o.lineId))!;
      const cur = currencyOf(line.currency, run.currency);
      return `${line.name} is owed ${formatMinor(o.remainingMinor, cur)}, not ${formatMinor(o.askedMinor, cur)}`;
    });
    throw new AppError("CONFLICT", `${said.join("; ")}. Nothing was recorded.`);
  }

  if (!allocations.length) {
    const { held, otherCurrency } = selection.skipped;
    const elsewhere =
      otherCurrency > 0
        ? `${otherCurrency} ${otherCurrency === 1 ? "person is" : "people are"} paid in another currency — pay them from an account in theirs.`
        : "";
    throw new AppError(
      "CONFLICT",
      held > 0
        ? `Nobody paid in ${account.currency} can be paid — ${held} person(s) are held. Release them on the run to pay them. ${elsewhere}`.trim()
        : otherCurrency > 0
          ? `Nobody ${input.lineIds?.length || asked ? "selected" : "still owed"} on ${run.runNumber} is paid in ${account.currency}. ${elsewhere}`
          : "There is nothing left to pay on this run.",
    );
  }

  const paidOn = new Date(input.paidOn);
  if (Number.isNaN(paidOn.getTime())) throw new AppError("VALIDATION_ERROR", "paidOn is not a valid date");

  const user = await User.findById(oid(actor.userId)).select("name").lean();
  // Counting the deleted ones too (2026-11-04), so a number once used is never handed out again.
  const paymentId = `${run.runNumber}-P${run.payments.length + ((run as unknown as { deletedPayments?: unknown[] }).deletedPayments?.length ?? 0) + 1}`;

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

  // Somebody paid in parts is finished by the payment that pays the last of it: HRMS hears of them then, and their
  // commission is settled then — not while some of their pay is still owed.
  const finished: Types.ObjectId[] = [];
  for (const alloc of allocations) {
    const line = run.lines.find((l) => String(l._id) === String(alloc.lineId))!;
    line.amountPaidMinor += alloc.amountMinor;
    line.status = line.amountPaidMinor >= line.payableMinor ? "paid" : "partially_paid";
    if (line.status === "paid") finished.push(line._id as Types.ObjectId);
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
    currency: account.currency,
    amountMinor,
    allocations,
    finishedLineIds: finished,
    syncedToHrms: false,
    syncAttempts: 0,
    createdById: oid(actor.userId),
    createdByName: user?.name ?? "",
  } as never);

  // Somebody owed nothing counts as settled, or a person whose salary was
  // entirely consumed by a recovery keeps the run open indefinitely.
  const anyOutstanding = run.lines.some((l) => !isSettled(l as unknown as PayableLine));
  const held = run.lines.filter((l) => l.status === "on_hold").length;
  run.status = anyOutstanding || held > 0 ? "partially_paid" : "paid";
  if (run.status === "paid") run.paidAt = new Date();
  await run.save();

  // ── Then everything that follows from it ─────────────────────────────────
  const sync = await syncPaymentToHrms(run, paymentId);
  const commissions = await settleCommissions(orgId, run, finished.map(String));
  // Without this the bank balance drops and no report explains why.
  const expenseId = await postPayrollExpense(orgId, run, paymentId, { userId: actor.userId, name: user?.name ?? "" });
  await run.save();

  return {
    paymentId,
    runNumber: run.runNumber,
    status: run.status,
    paidCount: allocations.length,
    /** Of them, how many are now paid in full; the rest are part paid and still owed. */
    finishedCount: finished.length,
    amountMinor,
    currency: account.currency,
    amountFormatted: formatMinor(amountMinor, account.currency),
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

  // Only the people it finished paying: a payslip says paid when all of it is, so a payment that paid somebody part
  // of theirs tells HRMS nothing about them. Each is sent with all they have been paid, this payment and before.
  const done = new Set(finishedBy(payment));
  const lines = run.lines
    .filter((l) => done.has(String(l._id)))
    .map((l) => ({ payslipId: l.hrmsPayslipId, amount: l.amountPaidMinor / 100 }));

  payment.syncAttempts += 1;
  payment.lastSyncAttemptAt = new Date();

  // Nobody finished — everybody in it part paid: nothing for HRMS to mark, so nothing waits on it.
  if (!lines.length) {
    payment.syncedToHrms = true;
    payment.syncError = "";
    return { ok: true, message: "" };
  }

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
    // Mailed as well as shown, because nobody has a reason to open this run
    // again — the payment appeared to succeed.
    void notifyPaymentNotSynced(String(run.organizationId), {
      runId: String(run._id),
      runNumber: run.runNumber,
      paymentId,
      amountMinor: payment.amountMinor,
      currency: payment.currency || run.currency,
      error: payment.syncError,
    });
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
  // The sales CRMs' commission on those lines (2026-11-01): paid with this transfer.
  const crmIds = run.adjustments
    .filter((a) => a.source === "crm_commission" && paidLineIds.includes(String(a.lineId)))
    .flatMap((a) => a.crmPayoutIds ?? []);
  if (crmIds.length) {
    await CrmCommissionPayout.updateMany(
      { _id: { $in: crmIds }, state: "approved" },
      { $set: { state: "paid", paidAt: new Date(), paidOn: new Date(), paidByName: `Payroll ${run.runNumber}`, paymentMethod: "payroll", reference: run.runNumber } },
    );
  }
  // The CS Portal's commission on those lines (2026-11-03): the same.
  const csIds = run.adjustments
    .filter((a) => a.source === "cs_commission" && paidLineIds.includes(String(a.lineId)))
    .flatMap((a) => a.csPayoutIds ?? []);
  if (csIds.length) {
    await CsCommissionPayout.updateMany(
      { _id: { $in: csIds }, state: "approved" },
      { $set: { state: "paid", paidAt: new Date(), paidOn: new Date(), paidByName: `Payroll ${run.runNumber}`, paymentMethod: "payroll", reference: run.runNumber } },
    );
  }
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


/** The last payment still standing that paid this person something: the one that closes their payslip. */
export function lastPaymentOf(run: PayrollRunDoc, lineId: unknown) {
  const mine = run.payments.filter((p) => !p.reversedAt && p.allocations.some((a) => String(a.lineId) === String(lineId)));
  return mine[mine.length - 1] ?? null;
}

/**
 * After an addition or deduction on somebody already paid some or all of theirs (the user, 2026-11-06: "if they
 * aren't paid, the status changes on its own; after they're paid we can also add or deduct and it goes to part
 * paid"): paid once nothing is left owed — finished by the last payment that paid them, which settles their commission
 * as a finishing payment does, and which reversing then opens again — and part paid when more is owed. The run follows.
 * HRMS has already been told, with the change itself. No money moves.
 */
export async function afterPayChange(orgId: string, run: PayrollRunDoc, lineIds: string[]): Promise<{ finished: string[]; reopened: string[] }> {
  const finished: string[] = [], reopened: string[] = [];
  for (const line of run.lines) {
    const id = String(line._id);
    if (!lineIds.includes(id) || !(line.amountPaidMinor > 0)) continue;
    const owed = line.payableMinor - line.amountPaidMinor;
    if (owed <= 0 && line.status !== "paid") {
      line.status = "paid";
      const last = lastPaymentOf(run, id);
      if (last) {
        const ids = finishedBy(last);
        if (!ids.includes(id)) last.finishedLineIds = [...ids, id].map((x) => oid(x)) as never;
      }
      finished.push(id);
    } else if (owed > 0 && line.status === "paid") {
      line.status = "partially_paid";
      for (const p of run.payments) {
        const ids = finishedBy(p);
        if (ids.includes(id)) p.finishedLineIds = ids.filter((x) => x !== id).map((x) => oid(x)) as never;
      }
      reopened.push(id);
    }
  }
  if (run.payments.some((p) => !p.reversedAt)) {
    const anyOutstanding = run.lines.some((l) => !isSettled(l as unknown as PayableLine));
    const held = run.lines.some((l) => l.status === "on_hold");
    run.status = anyOutstanding || held ? "partially_paid" : "paid";
    run.paidAt = run.status === "paid" ? run.paidAt ?? new Date() : null;
  }
  if (finished.length) await settleCommissions(orgId, run, finished);
  return { finished, reopened };
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

  // Somebody it paid part of, whose pay a later payment finished: HRMS has their payslip paid by that one, so this
  // one can't come off first — they would be owed money here with a payslip saying paid there.
  const mine = new Set(finishedBy(payment));
  const blockers: string[] = [];
  for (const alloc of payment.allocations) {
    const id = String(alloc.lineId);
    const line = run.lines.find((l) => String(l._id) === id);
    if (!line || line.status !== "paid" || mine.has(id)) continue;
    const later = run.payments.find((p) => p !== payment && !p.reversedAt && finishedBy(p).includes(id));
    if (later) blockers.push(`${line.name}'s pay was finished by ${later.paymentId}`);
  }
  if (blockers.length) {
    throw new AppError("CONFLICT", `${blockers.join("; ")} — reverse that first, then this one.`);
  }

  // HRMS first, and only if it ever knew. Reversing here while the payslips
  // still say paid would leave the employee's record claiming money that came
  // back — the exact disagreement this whole handover exists to prevent.
  // A payment that finished nobody never reached HRMS: there is nothing there to undo.
  if (payment.syncedToHrms && mine.size > 0) {
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

  // Only the commission this payment settled: somebody it paid part of has none settled yet.
  const unsettled = await unsettleCommissions(orgId, run, [...mine]);
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
    message: `${formatMinor(payment.amountMinor, payment.currency || run.currency)} reversed across ${payment.allocations.length} people`,
    status: run.status,
    commissionsReopened: unsettled,
    bankTransactionId: reversalTxId ? String(reversalTxId) : null,
  };
}

/** Put commission back to earned when the payroll that paid it was reversed. */
async function unsettleCommissions(orgId: string, run: PayrollRunDoc, lineIds: string[]): Promise<number> {
  // The sales CRMs' commission on those lines: owed again, still on this run (2026-11-01).
  const crmIds = run.adjustments
    .filter((a) => a.source === "crm_commission" && lineIds.includes(String(a.lineId)))
    .flatMap((a) => a.crmPayoutIds ?? []);
  if (crmIds.length) {
    await CrmCommissionPayout.updateMany(
      { _id: { $in: crmIds }, state: "paid", paymentMethod: "payroll" },
      { $set: { state: "approved" }, $unset: { paidAt: 1, paidOn: 1, paidByName: 1, paymentMethod: 1, reference: 1 } },
    );
  }
  const csIds = run.adjustments
    .filter((a) => a.source === "cs_commission" && lineIds.includes(String(a.lineId)))
    .flatMap((a) => a.csPayoutIds ?? []);
  if (csIds.length) {
    await CsCommissionPayout.updateMany(
      { _id: { $in: csIds }, state: "paid", paymentMethod: "payroll" },
      { $set: { state: "approved" }, $unset: { paidAt: 1, paidOn: 1, paidByName: 1, paymentMethod: 1, reference: 1 } },
    );
  }
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

/**
 * What deleting the expense a payroll payment posted would do (2026-11-04) — for the delete dialog. Null for an expense
 * no payroll payment posted.
 */
export async function payrollPaymentOfExpense(orgId: string, expenseId: string): Promise<{
  runId: string; runNumber: string; period: string; paymentId: string; reversed: boolean; amountMinor: number; currency: string;
  people: string[]; reconciled: boolean;
} | null> {
  if (!Types.ObjectId.isValid(expenseId)) return null;
  const run = await PayrollRun.findOne({ organizationId: oid(orgId), "payments.expenseId": oid(expenseId) });
  const payment = run?.payments.find((p) => String(p.expenseId) === expenseId);
  if (!run || !payment) return null;
  const lines = [payment.bankTransactionId, payment.reversalTransactionId].filter(Boolean);
  const reconciled = lines.length > 0 && Boolean(await BankTransaction.exists({ _id: { $in: lines }, isReconciled: true }));
  return {
    runId: String(run._id), runNumber: run.runNumber, period: run.period, paymentId: payment.paymentId,
    reversed: Boolean(payment.reversedAt), amountMinor: payment.amountMinor, currency: payment.currency || run.currency,
    people: payment.allocations.map((a) => run.lines.find((l) => String(l._id) === String(a.lineId))?.name ?? "").filter(Boolean),
    reconciled,
  };
}

/**
 * The expense a payroll payment posted, deleted — and the payment with it, from everywhere it reached (the user,
 * 2026-11-04: "delete it from its connected areas also").
 *
 * Not reversed yet: it is reversed first, for the reason given, exactly as Reverse on the run does — HRMS has the
 * payslips back to issued, the people are owed again here, the commission it settled is open again. Then the
 * payment's two bank lines (out, and back in — together nothing) go, the account's balances are worked out again,
 * the expense and its receipts go, and the payment leaves the run's payments — remembered in `deletedPayments`, so the
 * run says what happened and its number is never handed out again. HRMS keeps its own record of the reversal.
 *
 * Refused while either bank line is reconciled against a statement — checked before anything is reversed.
 */
export async function deletePayrollPayment(
  orgId: string,
  expenseId: string,
  input: { reason?: string },
  actor: { name: string },
): Promise<{ paymentId: string; reversedNow: boolean }> {
  const { assertDebitMovable } = await import("../banking/money-out");
  const { recalculateRunningBalances } = await import("../banking/banking.service");
  let run = await PayrollRun.findOne({ organizationId: oid(orgId), "payments.expenseId": oid(expenseId) });
  let payment = run?.payments.find((p) => String(p.expenseId) === expenseId);
  if (!run || !payment) throw new AppError("NOT_FOUND", "No payroll payment posted this expense");
  const reason = (input.reason ?? "").trim();

  await assertDebitMovable(orgId, payment.bankTransactionId);
  await assertDebitMovable(orgId, payment.reversalTransactionId);
  const reversedNow = !payment.reversedAt;
  if (reversedNow) {
    if (reason.length < 3) {
      throw new AppError("VALIDATION_ERROR", `Say why — deleting it reverses ${payment.paymentId} first: its people are owed again and HRMS has their payslips back to issued.`);
    }
    await reversePayment(orgId, String(run._id), payment.paymentId, reason);
    run = await PayrollRun.findById(run._id);
    payment = run?.payments.find((p) => String(p.expenseId) === expenseId);
    if (!run || !payment) throw new AppError("CONFLICT", "The payment changed while it was being reversed — try again");
  }

  // Its two lines in the bank, out and back in: nothing together, so the account ends where it was.
  const lineIds = [payment.bankTransactionId, payment.reversalTransactionId].filter(Boolean);
  if (lineIds.length) {
    const lines = await BankTransaction.find({ _id: { $in: lineIds }, organizationId: oid(orgId) }).select("accountId").lean<{ accountId: Types.ObjectId }[]>();
    await BankTransaction.deleteMany({ _id: { $in: lineIds }, organizationId: oid(orgId) });
    for (const acc of new Set(lines.map((l) => String(l.accountId)))) await recalculateRunningBalances(orgId, oid(acc));
  }

  const { removeExpense } = await import("../expense/expense.service");
  const expenseNumber = await removeExpense(orgId, expenseId);

  const gone = payment;
  run.payments.pull(gone._id);
  (run as unknown as { deletedPayments: unknown[] }).deletedPayments.push({
    paymentId: gone.paymentId, amountMinor: gone.amountMinor, currency: gone.currency || run.currency, paidOn: gone.paidOn,
    expenseNumber, reason: reason || gone.reversalReason || "", deletedAt: new Date(), deletedByName: actor.name,
  });
  await run.save();
  return { paymentId: gone.paymentId, reversedNow };
}


/** One person in a payroll payment's breakdown. */
export interface PayrollBreakdownRow {
  lineId: string; name: string; employeeCode: string; departmentName: string; designation: string;
  /** What this payment paid them. */
  paidMinor: number;
  /** Their pay for the month on the run. */
  payableMinor: number;
  /** This payment paid the last of it — or, from before part payments, paid them in full. */
  finished: boolean;
}

/**
 * Who a payroll payment paid, and how much each (the user, 2026-11-04: "for the payroll expense, which employee and
 * how much") — by the expense it posted. Null for an expense no payroll payment posted.
 */
export async function payrollBreakdownOfExpense(orgId: string, expenseId: string): Promise<{
  runId: string; runNumber: string; period: string; paymentId: string; method: string; paidOn: string;
  bankAccountName: string; reference: string; currency: string; amountMinor: number;
  reversed: boolean; reversalReason: string; rows: PayrollBreakdownRow[];
  /** The payment record itself (2026-11-05: "show the payment record … and a link"): its account and line in Banking, who recorded it, HRMS. */
  bankAccountId: string | null; bankTransactionId: string | null; reversalTransactionId: string | null;
  reversedAt: string | null; recordedByName: string; recordedAt: string | null;
  people: number; finishedCount: number; syncedToHrms: boolean; syncError: string;
} | null> {
  if (!Types.ObjectId.isValid(expenseId)) return null;
  const run = await PayrollRun.findOne({ organizationId: oid(orgId), "payments.expenseId": oid(expenseId) }).lean<any>();
  const payment = run?.payments.find((p: any) => String(p.expenseId) === expenseId);
  if (!run || !payment) return null;
  const finished = new Set((payment.finishedLineIds?.length ? payment.finishedLineIds : payment.allocations.map((a: any) => a.lineId)).map(String));
  const rows: PayrollBreakdownRow[] = payment.allocations.map((a: any) => {
    const l = run.lines.find((x: any) => String(x._id) === String(a.lineId));
    return {
      lineId: String(a.lineId), name: l?.name ?? "", employeeCode: l?.employeeCode ?? "", departmentName: l?.departmentName ?? "",
      designation: l?.designation ?? "", paidMinor: a.amountMinor, payableMinor: l?.payableMinor ?? a.amountMinor,
      finished: finished.has(String(a.lineId)),
    };
  }).sort((x: PayrollBreakdownRow, y: PayrollBreakdownRow) => x.name.localeCompare(y.name));
  return {
    runId: String(run._id), runNumber: run.runNumber, period: run.period, paymentId: payment.paymentId, method: payment.method,
    paidOn: new Date(payment.paidOn).toISOString().slice(0, 10), bankAccountName: payment.bankAccountName ?? "",
    reference: payment.reference ?? "", currency: payment.currency || run.currency, amountMinor: payment.amountMinor,
    reversed: Boolean(payment.reversedAt), reversalReason: payment.reversalReason ?? "", rows,
    bankAccountId: payment.bankAccountId ? String(payment.bankAccountId) : null,
    bankTransactionId: payment.bankTransactionId ? String(payment.bankTransactionId) : null,
    reversalTransactionId: payment.reversalTransactionId ? String(payment.reversalTransactionId) : null,
    reversedAt: payment.reversedAt ? new Date(payment.reversedAt).toISOString() : null,
    recordedByName: payment.createdByName ?? "", recordedAt: payment.createdAt ? new Date(payment.createdAt).toISOString() : null,
    people: rows.length, finishedCount: finished.size, syncedToHrms: Boolean(payment.syncedToHrms), syncError: payment.syncError ?? "",
  };
}
