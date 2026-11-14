import { Types } from "mongoose";
import {
  EXPENSE_DEFAULTS, pspChargesVatMinor,
  type CreatePspSettlementInput, type PspAccountSummary, type PspSettlementDTO, type PspSummary, type PspUnsettledLine,
} from "@delta/shared";
import { AppError } from "../../lib/http";
import { BankAccount } from "../banking/bank-account.model";
import { BankTransaction } from "../banking/bank-transaction.model";
import { PspSettlement, type PspSettlementDoc } from "./psp-settlement.model";

/*
 * PSP settlements (the user, 2026-11-06: "PSP banks … when they settle there are charges, it moves to which bank, and
 * we can set up how much the charges are"). A PSP account — Tabby, Tamara, Billexpro, Easebuzz, a card acquirer — takes
 * clients' payments whole (invoice/payment-bank: no charges line of its own there). When the provider pays some of them
 * on, a settlement records it:
 *   - the money-in lines it covers, marked settled (they no longer change but with the settlement);
 *   - a transfer of what arrived, from the PSP account to the bank it settles into;
 *   - its charges — what was settled less what arrived — as an expense, Bank Fees & Charges › Payment Gateway Fees,
 *     paid from the PSP account (VAT split out at the account's rate), so it reaches the P&L.
 * The PSP account ends with nothing left of those payments. Each settlement has its own charges (the user,
 * 2026-11-14): no rate is kept on the account any more, nothing is guessed ahead, and what is booked is only what
 * that settlement says. Deleting a settlement undoes all of it — not once a bank statement was reconciled against its
 * transfer or charges.
 */

const oid = (v: unknown) => new Types.ObjectId(String(v));
const day = (d: unknown) => new Date(d as Date).toISOString().slice(0, 10);
const DAY_MS = 86_400_000;

type Psp = { provider: string; feeVatPct: number; settlementAccountId: Types.ObjectId; settlementDays: number; startDate: Date };
type PspAccount = { _id: Types.ObjectId; accountName: string; currency: string; isActive?: boolean; accountType: string; psp: Psp | null };

async function pspAccount(orgId: string, id: string): Promise<PspAccount & { psp: Psp }> {
  if (!Types.ObjectId.isValid(id)) throw new AppError("NOT_FOUND", "Bank account not found");
  const acc = await BankAccount.findOne({ _id: oid(id), organizationId: oid(orgId) })
    .select("accountName currency isActive accountType psp").lean<PspAccount>();
  if (!acc) throw new AppError("NOT_FOUND", "Bank account not found");
  if (acc.accountType !== "psp" || !acc.psp?.settlementAccountId) throw new AppError("CONFLICT", `${acc.accountName} is not a PSP account`);
  return acc as PspAccount & { psp: Psp };
}

/** Money-in lines a settlement could take: credits in the account, not a transfer, not settled, on or after its start. */
function unsettledFilter(orgId: string, acc: PspAccount & { psp: Psp }) {
  return {
    organizationId: oid(orgId), accountId: acc._id, type: "credit", amountMinor: { $gt: 0 },
    transfer: null, settlement: null, date: { $gte: acc.psp.startDate },
  };
}

function lineOf(tx: any, psp: Psp, now: number): PspUnsettledLine {
  const inv = (tx.matches ?? []).find((m: any) => m.type === "invoice");
  const expected = new Date(new Date(tx.date).getTime() + (psp.settlementDays ?? 0) * DAY_MS);
  return {
    id: String(tx._id), date: day(tx.date), description: tx.description ?? "", reference: tx.reference ?? "",
    amountMinor: tx.amountMinor, invoice: inv ? { id: String(inv.referenceId), number: String(inv.referenceNumber) } : null,
    expectedOn: day(expected),
    // Late once the day it was due has gone by (Dubai's day, as the rest of finance counts days).
    late: expected.getTime() + DAY_MS <= now + 4 * 3_600_000,
  };
}

/** The money in the PSP account not settled yet, oldest first — up to `to` (a day) when given. */
export async function unsettledLines(orgId: string, accountId: string, opts: { to?: string } = {}): Promise<PspUnsettledLine[]> {
  const acc = await pspAccount(orgId, accountId);
  const filter: Record<string, unknown> = unsettledFilter(orgId, acc);
  if (opts.to && /^\d{4}-\d{2}-\d{2}$/.test(opts.to)) filter.date = { $gte: acc.psp.startDate, $lte: new Date(`${opts.to}T23:59:59.999Z`) };
  const lines = await BankTransaction.find(filter).sort({ date: 1, createdAt: 1 }).limit(5000).lean<any[]>();
  const now = Date.now();
  return lines.map((tx) => lineOf(tx, acc.psp, now));
}

/** What a PSP account holds unsettled, and how much of it is late. */
export async function pspSummary(orgId: string, accountId: string): Promise<PspSummary> {
  const lines = await unsettledLines(orgId, accountId);
  const late = lines.filter((l) => l.late);
  return {
    unsettledMinor: lines.reduce((a, l) => a + l.amountMinor, 0),
    unsettledCount: lines.length,
    lateCount: late.length,
    lateMinor: late.reduce((a, l) => a + l.amountMinor, 0),
  };
}

/**
 * Every open PSP account and what it holds unsettled, the most waiting first — the dashboard's card (2026-11-06).
 * One account that can't be read is left out rather than failing the rest.
 */
export async function allPspSummaries(orgId: string): Promise<PspAccountSummary[]> {
  const accounts = await BankAccount.find({ organizationId: oid(orgId), accountType: "psp", isActive: { $ne: false }, "psp.settlementAccountId": { $exists: true } })
    .select("accountName currency psp").lean<Array<{ _id: Types.ObjectId; accountName: string; currency: string; psp: Psp & { settlementAccountName?: string } }>>();
  const out: PspAccountSummary[] = [];
  for (const a of accounts) {
    try {
      const lines = await unsettledLines(orgId, String(a._id));
      const late = lines.filter((l) => l.late);
      out.push({
        accountId: String(a._id), accountName: a.accountName, provider: a.psp?.provider ?? "", currency: a.currency,
        settlementAccountName: a.psp?.settlementAccountName ?? "",
        unsettledMinor: lines.reduce((s, l) => s + l.amountMinor, 0), unsettledCount: lines.length,
        lateCount: late.length, lateMinor: late.reduce((s, l) => s + l.amountMinor, 0),
        oldestDate: lines[0]?.date ?? null,
      });
    } catch { /* left out */ }
  }
  return out.sort((x, y) => y.lateMinor - x.lateMinor || y.unsettledMinor - x.unsettledMinor);
}

function toDTO(d: PspSettlementDoc): PspSettlementDTO {
  return {
    id: String(d._id), number: d.number, date: day(d.date), pspAccountId: String(d.pspAccountId), pspAccountName: d.pspAccountName,
    bankAccountId: String(d.bankAccountId), bankAccountName: d.bankAccountName, currency: d.currency, lineCount: (d.lineIds ?? []).length,
    grossMinor: d.grossMinor, receivedMinor: d.receivedMinor, feeMinor: d.feeMinor,
    expense: d.expenseId ? { id: String(d.expenseId), number: d.expenseNumber ?? "" } : null,
    reference: d.reference ?? "", notes: d.notes ?? "", createdByName: d.createdByName ?? "",
    createdAt: new Date(d.createdAt).toISOString(),
  };
}

export async function listSettlements(orgId: string, accountId: string): Promise<PspSettlementDTO[]> {
  const rows = await PspSettlement.find({ organizationId: oid(orgId), pspAccountId: oid(accountId) }).sort({ date: -1, createdAt: -1 }).limit(500).lean<PspSettlementDoc[]>();
  return rows.map(toDTO);
}

/**
 * The provider paid these payments on: the transfer of what arrived, this settlement's own charges as an expense, the
 * lines marked settled. Refused for a line that is not this account's unsettled money in, an amount more than what is
 * settled, or charges typed that are not what was settled less what arrived.
 */
export async function createSettlement(
  orgId: string, accountId: string, input: CreatePspSettlementInput, actor: { userId: string; name: string },
): Promise<PspSettlementDTO> {
  const acc = await pspAccount(orgId, accountId);
  const bank = await BankAccount.findOne({ _id: acc.psp.settlementAccountId, organizationId: oid(orgId) })
    .select("accountName currency isActive").lean<{ _id: Types.ObjectId; accountName: string; currency: string; isActive?: boolean }>();
  if (!bank || bank.isActive === false) throw new AppError("CONFLICT", `The account ${acc.accountName} settles into is gone or closed — change it in its PSP settings`);
  if (bank.currency !== acc.currency) throw new AppError("CONFLICT", `${bank.accountName} is in ${bank.currency}, ${acc.accountName} in ${acc.currency}`);

  const ids = [...new Set(input.lineIds)].filter((x) => Types.ObjectId.isValid(x)).map(oid);
  const lines = await BankTransaction.find({ ...unsettledFilter(orgId, acc), _id: { $in: ids } }).lean<any[]>();
  if (lines.length !== input.lineIds.length) {
    throw new AppError("CONFLICT", `${input.lineIds.length - lines.length} of the payments picked are not ${acc.accountName}'s money waiting to be settled — refresh and pick again`);
  }
  const gross = lines.reduce((a, l) => a + l.amountMinor, 0);
  if (input.receivedMinor > gross) throw new AppError("VALIDATION_ERROR", `More arrived than the payments picked come to — pick the rest of what was settled`);
  const fee = gross - input.receivedMinor;
  // The charges as they were typed must be what is about to be booked — else the screen was looking at other payments.
  if (input.feeMinor !== undefined && input.feeMinor !== fee) {
    throw new AppError("CONFLICT", "The charges typed don't come to what was settled less what arrived — refresh and record it again");
  }

  const { nextNumber } = await import("../sequence/sequence.service");
  const number = await nextNumber(orgId, "psp_settlement", "PS-");
  const id = new Types.ObjectId();
  const mark = { id, number };
  const reference = (input.reference || number).slice(0, 100);
  const what = `${acc.psp.provider || acc.accountName} settlement ${number} · ${lines.length} ${lines.length === 1 ? "payment" : "payments"}`;

  // Marked first, with a filter that wants them unsettled: two people settling the same payments can't both win.
  const marked = await BankTransaction.updateMany({ _id: { $in: lines.map((l) => l._id) }, settlement: null }, { $set: { settlement: mark } });
  if (marked.modifiedCount !== lines.length) {
    await BankTransaction.updateMany({ _id: { $in: lines.map((l) => l._id) }, "settlement.id": id }, { $set: { settlement: null } });
    throw new AppError("CONFLICT", "Some of these payments were settled a moment ago — refresh and pick again");
  }

  let transferId: Types.ObjectId | null = null;
  let expense: { id: Types.ObjectId; number: string } | null = null;
  try {
    const { createTransfer } = await import("../banking/transfer.service");
    const t = await createTransfer(orgId, {
      fromAccountId: String(acc._id), toAccountId: String(bank._id), date: input.date, amountMinor: input.receivedMinor,
      reference, notes: `${what}${input.notes ? ` — ${input.notes}` : ""}`.slice(0, 1000),
    } as never);
    transferId = oid(t.id);
    await BankTransaction.updateMany({ organizationId: oid(orgId), "transfer.id": transferId }, { $set: { settlement: mark, description: `${what} → ${bank.accountName}` } });
    await BankTransaction.updateOne({ organizationId: oid(orgId), "transfer.id": transferId, amountMinor: { $gt: 0 } }, { $set: { description: `${what} from ${acc.accountName}` } });
    if (fee > 0) expense = await feeExpense(orgId, acc, { id, number, date: input.date, fee, reference, what, lines: lines.length }, actor);
  } catch (err) {
    await undoParts(orgId, { id, transferId, expenseId: expense?.id ?? null });
    throw err;
  }

  const doc = await PspSettlement.create({
    _id: id, organizationId: oid(orgId), number, date: new Date(input.date), pspAccountId: acc._id, pspAccountName: acc.accountName,
    bankAccountId: bank._id, bankAccountName: bank.accountName, currency: acc.currency, lineIds: lines.map((l) => l._id),
    grossMinor: gross, receivedMinor: input.receivedMinor, feeMinor: fee,
    transferId, expenseId: expense?.id ?? null, expenseNumber: expense?.number ?? "", reference: input.reference ?? "",
    notes: input.notes ?? "", createdById: Types.ObjectId.isValid(actor.userId) ? oid(actor.userId) : null, createdByName: actor.name,
  });
  return toDTO(doc.toObject() as PspSettlementDoc);
}

/** The fee as an expense paid from the PSP account — net and VAT at the account's rate — its line marked settled. */
async function feeExpense(
  orgId: string, acc: PspAccount & { psp: Psp },
  s: { id: Types.ObjectId; number: string; date: string; fee: number; reference: string; what: string; lines: number },
  actor: { userId: string; name: string },
): Promise<{ id: Types.ObjectId; number: string }> {
  const { Expense } = await import("../expense/expense.model");
  const { resolveExpenseCategory } = await import("../expense-category/expense-category.service");
  const { nextNumber } = await import("../sequence/sequence.service");
  const { placeExpenseInBank } = await import("../expense/expense.service");
  const cat = await resolveExpenseCategory(orgId, EXPENSE_DEFAULTS.pspFee.category, EXPENSE_DEFAULTS.pspFee.subcategory);
  const vatPct = acc.psp.feeVatPct ?? 0;
  const net = s.fee - pspChargesVatMinor(s.fee, vatPct);
  const expenseNumber = await nextNumber(orgId, "expense", "EXP-");
  const paidOn = new Date(s.date);
  const doc = (await Expense.create({
    organizationId: oid(orgId), expenseNumber,
    category: cat.category, categoryName: cat.categoryName, subcategory: cat.subcategory, subcategoryName: cat.subcategoryName,
    description: `${s.what} — fees`.slice(0, 300), expenseDate: paidOn,
    amountMinor: net, taxPct: vatPct, taxMinor: s.fee - net, totalMinor: s.fee, taxInclusive: true,
    currency: acc.currency,
    paymentAccount: acc.accountName, paymentMethod: "bank_transfer", bankAccountId: acc._id, paidOn, reference: s.reference,
    submittedById: Types.ObjectId.isValid(actor.userId) ? oid(actor.userId) : undefined, submittedByName: actor.name || "Finance",
    status: "approved", approvedById: Types.ObjectId.isValid(actor.userId) ? oid(actor.userId) : undefined, approvedByName: actor.name || "Finance", approvedAt: new Date(),
    notes: `The fee ${acc.accountName} kept when it settled ${s.lines} ${s.lines === 1 ? "payment" : "payments"} (${s.number}). It goes with the settlement.`,
    source: { kind: "psp_settlement", key: `psp:${s.id}` },
  } as never)) as unknown as { _id: Types.ObjectId };
  await placeExpenseInBank(orgId, doc._id);
  const placed = await Expense.findById(doc._id).select("bankTransactionId").lean<{ bankTransactionId?: Types.ObjectId | null }>();
  if (placed?.bankTransactionId) await BankTransaction.updateOne({ _id: placed.bankTransactionId }, { $set: { settlement: { id: s.id, number: s.number } } });
  return { id: doc._id as Types.ObjectId, number: expenseNumber };
}

/** Takes off what a settlement made — its transfer, its fee expense and their lines — and frees the payments it took. */
async function undoParts(orgId: string, s: { id: Types.ObjectId; transferId: Types.ObjectId | null; expenseId: Types.ObjectId | null }): Promise<void> {
  const { recalculateRunningBalances } = await import("../banking/banking.service");
  const touched = new Set<string>();
  if (s.transferId) {
    const t = await BankTransaction.find({ organizationId: oid(orgId), "transfer.id": s.transferId }).select("accountId").lean<any[]>();
    await BankTransaction.deleteMany({ organizationId: oid(orgId), "transfer.id": s.transferId });
    for (const l of t) touched.add(String(l.accountId));
  }
  if (s.expenseId) {
    const { Expense } = await import("../expense/expense.model");
    const e = await Expense.findOne({ _id: s.expenseId, organizationId: oid(orgId) }).select("bankTransactionId").lean<any>();
    if (e?.bankTransactionId) {
      const line = await BankTransaction.findOneAndDelete({ _id: e.bankTransactionId, organizationId: oid(orgId) }).lean<any>();
      if (line) touched.add(String(line.accountId));
    }
    const { removeExpense } = await import("../expense/expense.service");
    await Expense.updateOne({ _id: s.expenseId }, { $set: { bankTransactionId: null } });
    await removeExpense(orgId, String(s.expenseId)).catch(() => undefined);
  }
  await BankTransaction.updateMany({ organizationId: oid(orgId), "settlement.id": s.id }, { $set: { settlement: null } });
  for (const a of touched) await recalculateRunningBalances(orgId, oid(a));
}

/** A settlement taken back: the payments wait again, its transfer and fee are gone. Not once a statement was reconciled against them. */
export async function deleteSettlement(orgId: string, accountId: string, settlementId: string): Promise<void> {
  if (!Types.ObjectId.isValid(settlementId)) throw new AppError("NOT_FOUND", "Settlement not found");
  const s = await PspSettlement.findOne({ _id: oid(settlementId), organizationId: oid(orgId), pspAccountId: oid(accountId) }).lean<PspSettlementDoc>();
  if (!s) throw new AppError("NOT_FOUND", "Settlement not found");
  const own = await BankTransaction.find({
    organizationId: oid(orgId), "settlement.id": s._id,
    $or: [...(s.transferId ? [{ "transfer.id": s.transferId }] : []), { "matches.type": "expense" }],
  }).select("isReconciled accountName").lean<any[]>();
  const reconciled = own.find((l) => l.isReconciled);
  if (reconciled) throw new AppError("CONFLICT", `${s.number}'s line in ${reconciled.accountName} has been reconciled against a bank statement — it can't be taken back now`);
  await undoParts(orgId, { id: s._id, transferId: s.transferId ?? null, expenseId: s.expenseId ?? null });
  await PspSettlement.deleteOne({ _id: s._id });
}
