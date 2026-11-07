import { Types } from "mongoose";
import type { AddStatementLineInput, CheckStatementInput, ReconciliationSession as ReconciliationSessionDTO, StatementCheck, StatementCheckBookLine, StatementCheckLine } from "@delta/shared";
import { createExpenseSchema } from "@delta/shared";
import { AppError } from "../../lib/http";
import { BankAccount } from "./bank-account.model";
import { BankTransaction } from "./bank-transaction.model";
import { ReconciliationSession } from "./reconciliation.model";
import { matchStatement, type BookLine, type StatementLine } from "./statement-match";

/**
 * Reconciling by uploading the bank statement (the user, 2026-11-07: "we provide a template, they upload it on the
 * form, we check it ourselves — if it is correct it reconciles, otherwise how much and which transaction is not
 * correct"). The browser reads the file (template or the bank's own export) into lines; here they are kept with the
 * session, checked against the account's lines (statement-match.ts), and what matched is ticked with the statement's
 * day — the session's difference worked out as for lines ticked by hand. What doesn't match is listed: an amount
 * that differs (its difference recordable as a bank charge, one click), a line the books lack (added to them, one
 * click), a book line the statement lacks. Bank, card and loan accounts: a petty cash tin is counted, not statemented.
 */

/** How far apart a statement line's day and its book line's may be: banks often post a day or two later. */
export const STATEMENT_WINDOW_DAYS = 3;
const DAY = 86_400_000;
const dayOf = (d: Date) => new Date(d).toISOString().slice(0, 10);
const oid = (id: string) => new Types.ObjectId(id);

async function openSession(orgId: string, accountId: string, sessionId: string) {
  const session = await ReconciliationSession.findOne({ _id: oid(sessionId), organizationId: oid(orgId), accountId: oid(accountId) });
  if (!session) throw new AppError("NOT_FOUND", "Reconciliation not found");
  if (session.status !== "open") throw new AppError("CONFLICT", "This reconciliation is completed — reopen it to check a statement against it");
  const account = await BankAccount.findOne({ _id: oid(accountId), organizationId: oid(orgId) }).select("accountType accountName currency").lean<any>();
  if (!account) throw new AppError("NOT_FOUND", "Bank account not found");
  if (account.accountType === "petty_cash") throw new AppError("CONFLICT", "A petty cash tin is counted, not reconciled against a statement — use Count the cash");
  return { session, account };
}

/** The statement file, kept with the reconciliation as evidence. */
export async function uploadStatementFile(orgId: string, accountId: string, sessionId: string, file: { buffer: Buffer; originalName: string; mimeType: string }) {
  const { session } = await openSession(orgId, accountId, sessionId);
  const { uploadFile, storageConfigured } = await import("../../lib/storage");
  if (!storageConfigured()) throw new AppError("VALIDATION_ERROR", "File storage is not configured");
  const safe = file.originalName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  const up = await uploadFile({ key: `bank-statements/${orgId}/${sessionId}/${Date.now()}-${safe}`, buffer: file.buffer, mimeType: file.mimeType, originalName: file.originalName });
  session.set("statementFile", { name: file.originalName.slice(0, 200), key: up.key, url: up.url, uploadedAt: new Date() });
  await session.save();
  return { name: file.originalName, url: up.url };
}

/** The statement checked against the books; what matched ticked. Lines left out: the ones uploaded last. */
export async function checkStatement(orgId: string, accountId: string, sessionId: string, input: CheckStatementInput): Promise<{ check: StatementCheck; session: ReconciliationSessionDTO }> {
  const { session } = await openSession(orgId, accountId, sessionId);
  const s = session as unknown as {
    statementLines?: Array<{ date: string; description: string; reference: string; amountMinor: number; balanceMinor: number | null }>;
    statementPairs?: Array<{ index: number; bookLineIds: Types.ObjectId[] }>;
    statementFileName?: string; periodFrom?: Date; periodTo?: Date; statementBalanceMinor: number;
  };
  if (input.lines?.length) {
    // A new statement: its lines replace the last, and pairs recorded against the last go with them.
    session.set("statementLines", input.lines.map((l) => ({
      date: l.date, description: l.description ?? "", reference: l.reference ?? "", amountMinor: l.amountMinor, balanceMinor: l.balanceMinor ?? null,
    })));
    session.set("statementPairs", []);
    session.set("statementFileName", input.fileName ?? "");
    await session.save();
  }
  // As plain values: a stored line is a sub-document, whose fields a spread doesn't copy.
  const stored = (session.toObject() as unknown as { statementLines?: typeof s.statementLines; statementPairs?: typeof s.statementPairs });
  const lines = (stored.statementLines ?? []).map((l, index) => ({
    date: l.date, description: l.description ?? "", reference: l.reference ?? "", amountMinor: l.amountMinor, balanceMinor: l.balanceMinor ?? null, index,
  }));
  if (!lines.length) throw new AppError("VALIDATION_ERROR", "Upload the statement first");

  // The period: the reconciliation's, else the statement's own first and last day.
  const sorted = lines.map((l) => l.date).sort();
  const from = s.periodFrom ? dayOf(s.periodFrom) : sorted[0]!;
  const to = s.periodTo ? dayOf(s.periodTo) : sorted[sorted.length - 1]!;
  const lo = new Date(Date.parse(`${from}T00:00:00Z`) - STATEMENT_WINDOW_DAYS * DAY);
  const hi = new Date(Date.parse(`${to}T00:00:00Z`) + (STATEMENT_WINDOW_DAYS + 1) * DAY);
  const docs = await BankTransaction.find({
    organizationId: oid(orgId), accountId: oid(accountId),
    $or: [
      { isReconciled: { $ne: true }, date: { $gte: lo, $lt: hi } },
      { _id: { $in: session.reconciledTransactionIds ?? [] } },
    ],
  }).select("date description reference amountMinor").lean<any[]>();
  const book: BookLine[] = docs.map((d) => ({ id: String(d._id), date: dayOf(d.date), amountMinor: d.amountMinor ?? 0, reference: d.reference ?? "", description: d.description ?? "" }));
  const bookById = new Map(book.map((b) => [b.id, b]));

  const stmt: StatementLine[] = lines.map((l) => ({ index: l.index, date: l.date, amountMinor: l.amountMinor, reference: l.reference, description: l.description }));
  const pairs = (stored.statementPairs ?? []).map((p) => ({ index: p.index, bookLineIds: p.bookLineIds.map(String) }));
  const { results, unmatchedBookIds } = matchStatement(stmt, book, { windowDays: STATEMENT_WINDOW_DAYS, pairs });

  // What matched is ticked, each with the statement's day where it isn't the line's own; the difference follows.
  const ticked: string[] = [];
  const statementDates: Record<string, string> = {};
  for (const r of results) {
    if (r.status !== "matched") continue;
    const day = lines[r.index]!.date;
    for (const id of r.bookLineIds) {
      ticked.push(id);
      const b = bookById.get(id);
      if (b && b.date !== day && day <= dayOf(session.statementDate as unknown as Date)) statementDates[id] = day;
    }
  }
  const { updateReconciliation } = await import("./banking.service");
  const updated = await updateReconciliation(orgId, sessionId, { reconciledTransactionIds: ticked, statementDates });

  const view = (b: BookLine): StatementCheckBookLine => ({ id: b.id, date: b.date, description: b.description, reference: b.reference, amountMinor: b.amountMinor });
  const checkLines: StatementCheckLine[] = results.map((r) => {
    const l = lines[r.index]!;
    return {
      index: r.index, date: l.date, description: l.description, reference: l.reference, amountMinor: l.amountMinor, balanceMinor: l.balanceMinor ?? null,
      status: r.status, bookLines: r.bookLineIds.map((id) => bookById.get(id)).filter((b): b is BookLine => !!b).map(view),
      ...(r.differenceMinor !== undefined ? { differenceMinor: r.differenceMinor } : {}),
    };
  });
  const notOnStatement = unmatchedBookIds.map((id) => bookById.get(id)!).filter((b) => b.date >= from && b.date <= to).sort((a, b) => a.date.localeCompare(b.date)).map(view);
  const balances = lines.filter((l) => l.balanceMinor !== null && l.balanceMinor !== undefined);
  const fileClosingMinor = balances.length ? balances[balances.length - 1]!.balanceMinor! : null;
  const count = (st: StatementCheckLine["status"]) => checkLines.filter((l) => l.status === st).length;
  const unexplainedMinor = checkLines.reduce((t, l) => t + (l.status === "amount_differs" ? l.differenceMinor ?? 0 : l.status === "not_in_books" ? l.amountMinor : 0), 0)
    - notOnStatement.reduce((t, b) => t + b.amountMinor, 0);
  const check: StatementCheck = {
    checkedAt: new Date().toISOString(),
    fileName: s.statementFileName ?? "",
    windowDays: STATEMENT_WINDOW_DAYS,
    lines: checkLines,
    notOnStatement,
    summary: {
      statementLines: checkLines.length, matched: count("matched"), amountDiffers: count("amount_differs"), notInBooks: count("not_in_books"),
      notOnStatement: notOnStatement.length,
      inMinor: lines.filter((l) => l.amountMinor > 0).reduce((t, l) => t + l.amountMinor, 0),
      outMinor: -lines.filter((l) => l.amountMinor < 0).reduce((t, l) => t + l.amountMinor, 0),
      unexplainedMinor,
      fileClosingMinor,
      closingAgrees: fileClosingMinor === null ? null : fileClosingMinor === s.statementBalanceMinor,
    },
    allMatch: count("matched") === checkLines.length && notOnStatement.length === 0 && updated.differenceMinor === 0,
  };
  await ReconciliationSession.updateOne({ _id: session._id }, { $set: { statementCheck: check } });
  return { check, session: { ...updated, statementCheck: check } };
}

function lineAt(session: { toObject(): unknown }, index: number) {
  const s = session.toObject() as { statementLines?: Array<{ date: string; description: string; reference: string; amountMinor: number }>; statementCheck?: StatementCheck };
  const line = s.statementLines?.[index];
  const checked = s.statementCheck?.lines.find((l) => l.index === index);
  if (!line || !checked) throw new AppError("NOT_FOUND", "That statement line isn't in the last check — check the statement again");
  return { line, checked };
}

/** An expense paid from the account, as the statement shows it — dated by the statement, no late-entry approval asked. */
async function paidExpense(orgId: string, userId: string, account: { _id: unknown; currency?: string }, x: {
  date: string; amountMinor: number; description: string; reference: string; category: string; subcategory: string;
}): Promise<string> {
  const { createExpense } = await import("../expense/expense.service");
  const { Expense } = await import("../expense/expense.model");
  const made = await createExpense(orgId, userId, createExpenseSchema.parse({
    category: x.category, subcategory: x.subcategory, description: x.description.slice(0, 500) || "From the bank statement",
    expenseDate: x.date, amountMinor: x.amountMinor, currency: account.currency ?? "AED", paymentMethod: "bank_transfer",
    bankAccountId: String(account._id), paidOn: x.date, reference: x.reference.slice(0, 100), requiresApproval: false,
    notes: "Recorded from the bank statement, on reconciling.",
  }));
  const line = (await Expense.findById(made.id).select("bankTransactionId").lean<{ bankTransactionId?: unknown } | null>())?.bankTransactionId;
  if (!line) throw new AppError("CONFLICT", `${made.expenseNumber} was recorded but has no line in the account (${made.bankNote ?? "its account is closed or in another currency"})`);
  return String(line);
}

/**
 * An amount that differs because the bank took a charge (the statement shows more going out, or less coming in): the
 * difference recorded as a Bank Charges expense paid from the account on the statement's day, and paired with the
 * book line — the two then match the statement line together.
 */
export async function recordStatementDifference(orgId: string, accountId: string, sessionId: string, index: number, userId: string) {
  const { session, account } = await openSession(orgId, accountId, sessionId);
  const { line, checked } = lineAt(session, index);
  if (checked.status !== "amount_differs" || !checked.bookLines[0]) throw new AppError("CONFLICT", "Only a line whose amount differs has a difference to record");
  const diff = checked.differenceMinor ?? 0;
  if (diff >= 0) throw new AppError("CONFLICT", "The statement shows more coming in (or less going out) than the books — that isn't a bank charge; correct the entry instead");
  const chargeLine = await paidExpense(orgId, userId, account, {
    date: line.date, amountMinor: -diff, description: `Bank charges — ${line.description || checked.bookLines[0].description}`,
    reference: line.reference, category: "bank_fees", subcategory: "bank_charges",
  });
  const pairs = ((session.toObject() as unknown as { statementPairs?: Array<{ index: number; bookLineIds: Types.ObjectId[] }> }).statementPairs ?? []).filter((p) => p.index !== index);
  pairs.push({ index, bookLineIds: [oid(checked.bookLines[0].id), oid(chargeLine)] });
  session.set("statementPairs", pairs);
  await session.save();
  return checkStatement(orgId, accountId, sessionId, {} as CheckStatementInput);
}

/**
 * A statement line the books lack, put in them: money out as an expense paid from the account (its category, else
 * Bank Charges), money in as an entry in the account — dated and worded as the statement has it. Then checked again,
 * when it matches.
 */
export async function addStatementLineToBooks(orgId: string, accountId: string, sessionId: string, index: number, userId: string, input: AddStatementLineInput) {
  const { session, account } = await openSession(orgId, accountId, sessionId);
  const { line, checked } = lineAt(session, index);
  if (checked.status !== "not_in_books") throw new AppError("CONFLICT", "That statement line is in the books already");
  if (line.amountMinor < 0) {
    await paidExpense(orgId, userId, account, {
      date: line.date, amountMinor: -line.amountMinor, description: line.description, reference: line.reference,
      category: input.category || "bank_fees", subcategory: input.category ? input.subcategory ?? "" : "bank_charges",
    });
  } else {
    const { addTransaction } = await import("./banking.service");
    await addTransaction(orgId, accountId, {
      date: line.date, description: line.description || "From the bank statement", reference: line.reference, amountMinor: line.amountMinor,
      notes: "Recorded from the bank statement, on reconciling.",
    } as never);
  }
  return checkStatement(orgId, accountId, sessionId, {} as CheckStatementInput);
}
