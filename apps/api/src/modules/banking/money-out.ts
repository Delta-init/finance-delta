import { Types } from "mongoose";
import { AppError } from "../../lib/http";
import { BankAccount } from "./bank-account.model";
import { BankTransaction } from "./bank-transaction.model";
import { recalculateRunningBalances } from "./banking.service";

/*
 * Money out of a Banking account for an expense or a bill payment (the user, 2026-10-16: "the bank will be a drop
 * down … backfill current payments also including expense, invoice and others").
 *
 * An invoice payment is a credit in its account (invoice/payment-bank.ts). An expense marked paid, and a payment on a
 * bill, are the other way: a debit, negative as payroll's is, so the account's balance goes down by what was paid.
 * Each has at most one line; it follows what it records — made, moved, changed, removed — and once a bank statement
 * has been reconciled against it (not a petty cash tin's count, which can be redone) it no longer moves.
 */

const oid = (v: unknown) => new Types.ObjectId(String(v));

export interface WantedDebit {
  accountId: string;
  date: Date;
  /** Positive: what went out. Stored negative. */
  amountMinor: number;
  description: string;
  reference: string;
  match: { type: "expense" | "bill"; referenceId: string; referenceNumber: string };
}

/** Refused when a bank statement was reconciled against this line (a petty cash tin's may still move). */
export async function assertDebitMovable(orgId: string, txId: unknown): Promise<void> {
  if (!txId) return;
  const tx = await BankTransaction.findOne({ _id: oid(txId), organizationId: oid(orgId) }).select("isReconciled accountId accountName").lean<any>();
  if (!tx?.isReconciled) return;
  const acc = await BankAccount.findById(tx.accountId).select("accountType").lean<any>();
  if (acc?.accountType === "petty_cash") return;
  throw new AppError("CONFLICT", `Its line in ${tx.accountName} has been reconciled against a bank statement — the account, amount and date can't change now`);
}

/** The account it may go into: this organization's, open, in its currency — or why not. */
export async function debitAccount(orgId: string, id: string, currency: string): Promise<{ id: string; name: string } | { note: string }> {
  if (!Types.ObjectId.isValid(id)) return { note: "That bank account is not one of this organization's" };
  const acc = await BankAccount.findOne({ _id: oid(id), organizationId: oid(orgId) }).select("accountName currency isActive").lean<any>();
  if (!acc) return { note: "That bank account is not one of this organization's" };
  if (acc.isActive === false) return { note: `${acc.accountName} is closed` };
  if (currency && acc.currency !== currency) return { note: `${acc.accountName} is in ${acc.currency}, this is in ${currency} — it stays out of the account` };
  return { id: String(acc._id), name: String(acc.accountName) };
}

/**
 * Brings one debit line into line with what it records. Returns the line's id (null when there is none). Throws only
 * when the line cannot be written at all; the caller decides whether that stops it.
 */
export async function syncDebitLine(orgId: string, haveId: unknown, want: WantedDebit | null): Promise<Types.ObjectId | null> {
  const have = haveId ? await BankTransaction.findOne({ _id: oid(haveId), organizationId: oid(orgId) }).lean<any>() : null;
  if (have && want && String(have.accountId) === want.accountId && have.amountMinor === -want.amountMinor
    && new Date(have.date).getTime() === want.date.getTime()) {
    if (have.description !== want.description || have.reference !== want.reference) {
      await BankTransaction.updateOne({ _id: have._id }, { $set: { description: want.description, reference: want.reference } });
    }
    return have._id;
  }
  if (have) {
    await BankTransaction.deleteOne({ _id: have._id });
    await recalculateRunningBalances(orgId, have.accountId);
  }
  if (!want || !(want.amountMinor > 0)) return null;
  const account = await BankAccount.findOne({ _id: oid(want.accountId), organizationId: oid(orgId) }).select("accountName currency").lean<any>();
  if (!account) return null;
  const tx = await BankTransaction.create({
    organizationId: oid(orgId), accountId: account._id, accountName: account.accountName, currency: account.currency,
    date: want.date, description: want.description.slice(0, 300), reference: want.reference.slice(0, 200),
    amountMinor: -want.amountMinor, type: "debit", runningBalanceMinor: 0, source: "manual", status: "matched",
    matches: [{ ...want.match, amountMinor: want.amountMinor }],
    notes: `Paid on ${want.match.type} ${want.match.referenceNumber} — it moves with the payment`,
  });
  await recalculateRunningBalances(orgId, account._id);
  return tx._id;
}
