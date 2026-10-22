import { Types } from "mongoose";
import type { BankTransaction as BankTransactionDTO, CreateTransferInput, UpdateTransferInput } from "@delta/shared";
import { AppError } from "../../lib/http";
import { lateForDate, openLateEntry, withdrawLateFor, type LateActor } from "../late-entry/late-entry.service";
import { BankAccount } from "./bank-account.model";
import { BankTransaction } from "./bank-transaction.model";
import { assertEditable, getTransaction, recalculateRunningBalances } from "./banking.service";

/*
 * Transfers between the organization's own accounts (the user, 2026-10-22: "a new item in petty cash, an internal
 * transfer"): a tin topped up from the bank, its cash banked, one bank to another. One transfer is two lines, written
 * and changed together — money out of one account and into the other on the same day — linked by `transfer.id`. It
 * is neither income nor an expense: no report counts bank lines, so the books are untouched; only the two balances
 * move. Between currencies both figures are kept: what left, and what arrived.
 *
 * Dated back like any typed line, it needs a reason and a manager (late entries): one request, on the "out" line,
 * and both lines wait together; rejected, both go (or both get their date back).
 */

const oid = (v: unknown) => new Types.ObjectId(String(v));

async function accountOf(orgId: string, id: string, which: string) {
  if (!Types.ObjectId.isValid(id)) throw new AppError("VALIDATION_ERROR", `Choose the account it ${which}`);
  const acc = await BankAccount.findOne({ _id: oid(id), organizationId: oid(orgId) }).lean<any>();
  if (!acc) throw new AppError("NOT_FOUND", "That account is not one of this organization's");
  if (acc.isActive === false) throw new AppError("CONFLICT", `${acc.accountName} is closed`);
  return acc as { _id: Types.ObjectId; accountName: string; currency: string; accountType: string };
}

/** What the managers are shown of a transfer typed in late — on its "out" line. */
function transferLateInfo(out: any, into: any) {
  return {
    kind: "bank_line" as const, refId: out._id, accountId: out.accountId, number: String(out.reference || "Transfer"),
    title: `Transfer · ${out.accountName} → ${into.accountName}`, amountMinor: Math.abs(out.amountMinor ?? 0), currency: String(out.currency ?? "AED"),
  };
}

/** Both lines of a transfer, "out" first; refused when either may not be changed (as a single line would be). */
async function pairOf(orgId: string, transferId: string) {
  if (!Types.ObjectId.isValid(transferId)) throw new AppError("NOT_FOUND", "Transfer not found");
  const lines = await BankTransaction.find({ organizationId: oid(orgId), "transfer.id": oid(transferId) });
  const out = lines.find((l) => (l.amountMinor as number) < 0);
  const into = lines.find((l) => (l.amountMinor as number) >= 0);
  if (!out || !into) throw new AppError("NOT_FOUND", "Transfer not found");
  // Reconciled to a statement (not a tin's count) or matched to a document: neither side moves.
  await assertEditable(orgId, String(out.accountId), String(out._id));
  await assertEditable(orgId, String(into.accountId), String(into._id));
  return { out, into };
}

export interface TransferResult {
  id: string;
  out: BankTransactionDTO;
  in: BankTransactionDTO;
}

async function resultOf(orgId: string, id: string, outId: unknown, inId: unknown): Promise<TransferResult> {
  return { id, out: await getTransaction(orgId, String(outId)), in: await getTransaction(orgId, String(inId)) };
}

export async function createTransfer(orgId: string, input: CreateTransferInput, late?: LateActor): Promise<TransferResult> {
  if (input.fromAccountId === input.toAccountId) throw new AppError("VALIDATION_ERROR", "A transfer is between two different accounts");
  const from = await accountOf(orgId, input.fromAccountId, "comes from");
  const to = await accountOf(orgId, input.toAccountId, "goes to");
  const sameCurrency = from.currency === to.currency;
  if (!sameCurrency && !input.receivedMinor) {
    throw new AppError("VALIDATION_ERROR", `${from.accountName} is in ${from.currency} and ${to.accountName} in ${to.currency} — say how much arrived in ${to.currency}`);
  }
  const received = sameCurrency ? input.amountMinor : input.receivedMinor!;
  const lateNow = await lateForDate(orgId, late ? { ...late, reason: input.lateReason ?? late.reason } : undefined, input.date, null, null);

  const id = new Types.ObjectId(), outId = new Types.ObjectId(), inId = new Types.ObjectId();
  const common = {
    organizationId: oid(orgId), date: new Date(input.date), reference: input.reference ?? "", notes: input.notes ?? "",
    runningBalanceMinor: 0, source: "manual" as const, lateEntry: lateNow.next ?? null,
  };
  const [out, into] = await BankTransaction.create([
    {
      ...common, _id: outId, accountId: from._id, accountName: from.accountName, currency: from.currency,
      description: `Transfer to ${to.accountName}`, amountMinor: -input.amountMinor, type: "debit",
      transfer: { id, otherAccountId: to._id, otherAccountName: to.accountName, otherTransactionId: inId, otherAmountMinor: received, otherCurrency: to.currency },
    },
    {
      ...common, _id: inId, accountId: to._id, accountName: to.accountName, currency: to.currency,
      description: `Transfer from ${from.accountName}`, amountMinor: received, type: "credit",
      transfer: { id, otherAccountId: from._id, otherAccountName: from.accountName, otherTransactionId: outId, otherAmountMinor: input.amountMinor, otherCurrency: from.currency },
    },
  ], { ordered: true });
  if (lateNow.pending) await openLateEntry(orgId, lateNow.pending, transferLateInfo(out, into));
  await recalculateRunningBalances(orgId, from._id);
  await recalculateRunningBalances(orgId, to._id);
  return resultOf(orgId, String(id), outId, inId);
}

export async function updateTransfer(orgId: string, transferId: string, input: UpdateTransferInput, late?: LateActor): Promise<TransferResult> {
  const { out, into } = await pairOf(orgId, transferId);
  const sameCurrency = out.currency === into.currency;
  const o = out as any, i = into as any;

  const lateNow = input.date !== undefined
    ? await lateForDate(orgId, late ? { ...late, reason: input.lateReason ?? late.reason } : undefined, input.date, out.date as Date, o.lateEntry)
    : null;
  if (lateNow && lateNow.next !== undefined) { o.lateEntry = lateNow.next; i.lateEntry = lateNow.next; }
  if (input.date !== undefined) { out.date = new Date(input.date); into.date = new Date(input.date); }
  if (input.reference !== undefined) { out.reference = input.reference; into.reference = input.reference; }
  if (input.notes !== undefined) { out.notes = input.notes; into.notes = input.notes; }
  const sent = input.amountMinor ?? Math.abs(out.amountMinor as number);
  const received = sameCurrency ? sent : input.receivedMinor ?? (into.amountMinor as number);
  out.amountMinor = -sent;
  into.amountMinor = received;
  o.transfer.otherAmountMinor = received;
  i.transfer.otherAmountMinor = sent;
  out.markModified("transfer");
  into.markModified("transfer");
  await out.save();
  await into.save();
  if (lateNow?.pending) await openLateEntry(orgId, lateNow.pending, transferLateInfo(out, into));
  else if (lateNow?.withdraw) await withdrawLateFor(orgId, "bank_line", out._id);
  await recalculateRunningBalances(orgId, out.accountId as Types.ObjectId);
  await recalculateRunningBalances(orgId, into.accountId as Types.ObjectId);
  return resultOf(orgId, transferId, out._id, into._id);
}

export async function deleteTransfer(orgId: string, transferId: string): Promise<void> {
  const { out, into } = await pairOf(orgId, transferId);
  await BankTransaction.deleteMany({ _id: { $in: [out._id, into._id] }, organizationId: oid(orgId) });
  await withdrawLateFor(orgId, "bank_line", out._id);
  await recalculateRunningBalances(orgId, out.accountId as Types.ObjectId);
  await recalculateRunningBalances(orgId, into.accountId as Types.ObjectId);
}
