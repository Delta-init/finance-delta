import { Types } from "mongoose";
import { AppError } from "../../lib/http";
import { BankAccount } from "./bank-account.model";
import { BankTransaction } from "./bank-transaction.model";

/* ─────────────────────────────────────────────────────────────────────────────
   Matching a money-out line in Banking to an expense — and only to an expense
   (the user, 2026-11-11: "Bank and expenses required matching only"). The
   expense is offered when it isn't in Banking yet, in the line's currency, for
   the same amount, dated within 3 days of the line (wider: any amount, 30 days,
   searchable). Matched, the expense is paid on the line's day from the line's
   account and the line is its line — nothing is added, so the money is counted
   once (expense.service adoptBankLine).
───────────────────────────────────────────────────────────────────────────── */

const DAY = 86_400_000;
const NEAR_DAYS = 3;
const WIDE_DAYS = 30;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface ExpenseCandidate {
  id: string; expenseNumber: string; description: string; expenseDate: string; totalMinor: number; currency: string;
  status: string; category: string; paid: boolean; sameAmount: boolean; daysApart: number;
}

async function lineFor(orgId: string, accountId: string, txId: string) {
  if (!Types.ObjectId.isValid(txId) || !Types.ObjectId.isValid(accountId)) throw new AppError("NOT_FOUND", "Transaction not found");
  const tx = await BankTransaction.findOne({ _id: new Types.ObjectId(txId), accountId: new Types.ObjectId(accountId), organizationId: new Types.ObjectId(orgId) }).lean<any>();
  if (!tx) throw new AppError("NOT_FOUND", "Transaction not found");
  return tx;
}

function refuseLine(tx: any): void {
  if (tx.amountMinor >= 0) throw new AppError("CONFLICT", "Money in isn't matched to an expense");
  if (tx.matches?.length) throw new AppError("CONFLICT", `This line is matched to ${tx.matches[0].type} ${tx.matches[0].referenceNumber} already`);
  if (tx.transfer?.id) throw new AppError("CONFLICT", "This line is one side of a transfer — it isn't an expense");
  if (tx.settlement?.number) throw new AppError("CONFLICT", `This line is part of PSP settlement ${tx.settlement.number}`);
}

/** The expenses this money-out line could be. */
export async function expenseCandidates(
  orgId: string, accountId: string, txId: string, opts: { wide?: boolean; q?: string } = {},
): Promise<{ line: { amountMinor: number; date: string; currency: string }; candidates: ExpenseCandidate[] }> {
  const tx = await lineFor(orgId, accountId, txId);
  refuseLine(tx);
  const { Expense } = await import("../expense/expense.model");
  const amount = -tx.amountMinor;
  const at = new Date(tx.date).getTime();
  const days = opts.wide ? WIDE_DAYS : NEAR_DAYS;
  const filter: Record<string, unknown> = {
    organizationId: new Types.ObjectId(orgId),
    currency: tx.currency,
    status: { $nin: ["voided", "rejected"] },
    bankTransactionId: null,
    "source.kind": { $nin: ["bill", "payroll", "psp_settlement"] },
    "lateEntry.state": { $ne: "pending" },
    expenseDate: { $gte: new Date(at - (days + 1) * DAY), $lte: new Date(at + (days + 1) * DAY) },
  };
  if (!opts.wide) filter.totalMinor = amount;
  const q = String(opts.q ?? "").trim().slice(0, 80);
  if (q) filter.$or = [{ description: { $regex: esc(q), $options: "i" } }, { expenseNumber: { $regex: esc(q), $options: "i" } }, { reference: { $regex: esc(q), $options: "i" } }];
  const rows = await Expense.find(filter).select("expenseNumber description expenseDate totalMinor currency status categoryName category paidOn").limit(200).lean<any[]>();
  const candidates = rows
    .map((e) => ({
      id: String(e._id), expenseNumber: String(e.expenseNumber ?? ""), description: String(e.description ?? ""),
      expenseDate: new Date(e.expenseDate).toISOString().slice(0, 10), totalMinor: Number(e.totalMinor ?? 0), currency: String(e.currency ?? ""),
      status: String(e.status ?? ""), category: String(e.categoryName || e.category || ""), paid: Boolean(e.paidOn),
      sameAmount: Number(e.totalMinor ?? 0) === amount, daysApart: Math.round(Math.abs(new Date(e.expenseDate).getTime() - at) / DAY),
    }))
    .filter((c) => c.daysApart <= days)
    .sort((a, b) => Number(b.sameAmount) - Number(a.sameAmount) || a.daysApart - b.daysApart)
    .slice(0, 30);
  return { line: { amountMinor: amount, date: new Date(tx.date).toISOString().slice(0, 10), currency: tx.currency }, candidates };
}

/** The line matched to this expense: the expense paid through it, the line its line. */
export async function matchLineToExpense(orgId: string, accountId: string, txId: string, expenseId: string) {
  const tx = await lineFor(orgId, accountId, txId);
  refuseLine(tx);
  if (!Types.ObjectId.isValid(expenseId)) throw new AppError("NOT_FOUND", "Expense not found");
  const account = await BankAccount.findOne({ _id: tx.accountId, organizationId: new Types.ObjectId(orgId) }).select("accountName isActive").lean<any>();
  if (!account || account.isActive === false) throw new AppError("CONFLICT", "That account is closed");
  const { adoptBankLine } = await import("../expense/expense.service");
  // Claimed first, so the expense's sync finds the line as it should be and two people can't take one line twice.
  const claimed = await BankTransaction.findOneAndUpdate(
    { _id: tx._id, "matches.0": { $exists: false }, adopted: { $ne: true } },
    { $set: { adopted: true } },
    { new: true },
  ).lean<any>();
  if (!claimed) throw new AppError("CONFLICT", "This line was matched a moment ago");
  try {
    const expense = await adoptBankLine(orgId, expenseId, {
      id: String(tx._id), accountId: String(tx.accountId), accountName: String(account.accountName), date: new Date(tx.date),
      amountMinor: -tx.amountMinor, currency: String(tx.currency),
    });
    await BankTransaction.updateOne({ _id: tx._id }, {
      $set: { status: "matched", matches: [{ type: "expense", referenceId: expense.id, referenceNumber: expense.expenseNumber, amountMinor: -tx.amountMinor }] },
    });
    return { expense };
  } catch (err) {
    await BankTransaction.updateOne({ _id: tx._id, "matches.0": { $exists: false } }, { $set: { adopted: false } });
    throw err;
  }
}
