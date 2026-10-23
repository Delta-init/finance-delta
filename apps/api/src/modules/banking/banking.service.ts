import { Types } from "mongoose";
import type {
  CreateBankAccountInput,
  UpdateBankAccountInput,
  BankAccount as BankAccountDTO,
  BankTransaction as BankTransactionDTO,
  ReconciliationSession as ReconciliationSessionDTO,
  ReconciliationOpening,
  BankAccountQuery,
  BankTransactionQuery,
  Paginated,
  CreateBankTransactionInput,
  UpdateBankTransactionInput,
  BulkImportTransactionsInput,
  PreviewImportInput,
  MatchTransactionInput,
  StartReconciliationInput,
  UpdateReconciliationInput,
  CashCountInput,
} from "@delta/shared";
import { fingerprint, compareCashCount } from "@delta/shared";
import { lateView } from "../late-entry/late-entry.model";
import { lateForDate, openLateEntry, withdrawLateFor, type LateActor } from "../late-entry/late-entry.service";
import { AppError } from "../../lib/http";
import { buildSort, pageMeta, searchOr, skipFor } from "../../lib/paginate";
import { BankAccount, type BankAccountDoc } from "./bank-account.model";
import { BankTransaction, type BankTransactionDoc } from "./bank-transaction.model";
import { computeRunningBalances, type BalanceRow } from "./running-balance";
import { ReconciliationSession, type ReconciliationSessionDoc } from "./reconciliation.model";

function dateOnly(d: Date | undefined): string {
  if (!d) return "";
  return d.toISOString().slice(0, 10);
}

function accountToDTO(doc: BankAccountDoc): BankAccountDTO {
  return {
    id: doc._id.toString(),
    accountName: doc.accountName,
    accountNumber: (doc.accountNumber as string) ?? "",
    bankName: (doc.bankName as string) ?? "",
    branch: (doc.branch as string) ?? "",
    ifsc: (doc.ifsc as string) ?? "",
    swift: (doc.swift as string) ?? "",
    iban: (doc.iban as string) ?? "",
    accountType: doc.accountType as BankAccountDTO["accountType"],
    currency: doc.currency,
    currentBalanceMinor: (doc.currentBalanceMinor as number) ?? 0,
    openingBalanceMinor: (doc.openingBalanceMinor as number) ?? 0,
    openingDate: dateOnly(doc.openingDate as unknown as Date),
    isActive: (doc.isActive as boolean) ?? true,
    lastReconciledAt: doc.lastReconciledAt
      ? (doc.lastReconciledAt as unknown as Date).toISOString()
      : undefined,
    lastReconciledStatementBalanceMinor: doc.lastReconciledStatementBalanceMinor as
      | number
      | undefined,
    notes: (doc.notes as string) ?? "",
    createdAt: (doc as unknown as { createdAt: Date }).createdAt.toISOString(),
  };
}

function txToDTO(doc: BankTransactionDoc): BankTransactionDTO {
  const matches = (
    (doc.matches as unknown as {
      type: string;
      referenceId: string;
      referenceNumber: string;
      amountMinor: number;
    }[]) ?? []
  ).map((m) => ({
    type: m.type as BankTransactionDTO["matches"][0]["type"],
    referenceId: m.referenceId,
    referenceNumber: m.referenceNumber,
    amountMinor: m.amountMinor,
  }));

  return {
    id: doc._id.toString(),
    accountId: doc.accountId.toString(),
    accountName: doc.accountName,
    currency: doc.currency,
    date: dateOnly(doc.date as unknown as Date),
    description: doc.description,
    reference: (doc.reference as string) ?? "",
    amountMinor: doc.amountMinor,
    type: doc.type as BankTransactionDTO["type"],
    runningBalanceMinor: doc.runningBalanceMinor,
    source: doc.source as BankTransactionDTO["source"],
    importBatchId: (doc.importBatchId as string | undefined) ?? undefined,
    externalId: (doc.externalId as string | undefined) ?? undefined,
    status: doc.status as BankTransactionDTO["status"],
    matches,
    isReconciled: (doc.isReconciled as boolean) ?? false,
    reconciledSessionId: (doc.reconciledSessionId as string | undefined) ?? undefined,
    statementDate: (doc as unknown as { statementDate?: Date | null }).statementDate ? dateOnly((doc as unknown as { statementDate: Date }).statementDate) : undefined,
    attachments: (((doc as unknown as { attachments?: unknown[] }).attachments) ?? []).map((a) => {
      const r = a as Record<string, unknown>;
      return {
        name: r.name as string,
        url: r.url as string,
        key: r.key as string | undefined,
        size: r.size as number | undefined,
        mimeType: r.mimeType as string | undefined,
        uploadedAt: r.uploadedAt ? new Date(r.uploadedAt as Date).toISOString() : undefined,
      };
    }),
    notes: (doc.notes as string) ?? "",
    createdAt: (doc as unknown as { createdAt: Date }).createdAt.toISOString(),
    lateEntry: lateView((doc as unknown as { lateEntry?: unknown }).lateEntry),
    ...transferView(doc),
    ...ownCategory(doc),
  };
}

/** The line's own category, if somebody gave it one (2026-10-22). */
function ownCategory(doc: BankTransactionDoc): { category?: BankTransactionDTO["category"] } {
  const d = doc as unknown as { category?: string | null; categoryName?: string; subcategory?: string | null; subcategoryName?: string };
  if (!d.category) return {};
  return {
    category: {
      slug: d.category,
      name: d.categoryName || d.category,
      ...(d.subcategory ? { subcategory: d.subcategory, subcategoryName: d.subcategoryName || d.subcategory } : {}),
      fromExpense: false,
    },
  };
}

/**
 * The category of the expense behind each line an expense paid from the account made (2026-10-22) — so the cash
 * book shows what every payment out was for, whether typed there or entered as an expense.
 */
async function withExpenseCategories(orgId: string, rows: BankTransactionDTO[]): Promise<BankTransactionDTO[]> {
  const ids = [...new Set(rows.flatMap((r) => (r.category ? [] : r.matches.filter((m) => m.type === "expense").map((m) => m.referenceId))))]
    .filter((id) => Types.ObjectId.isValid(id));
  if (!ids.length) return rows;
  const { Expense } = await import("../expense/expense.model");
  const found = await Expense.find({ _id: { $in: ids.map((id) => new Types.ObjectId(id)) }, organizationId: new Types.ObjectId(orgId) })
    .select("category categoryName subcategory subcategoryName").lean<any[]>();
  const byId = new Map(found.map((e) => [String(e._id), e]));
  return rows.map((r) => {
    if (r.category) return r;
    const e = r.matches.filter((m) => m.type === "expense").map((m) => byId.get(m.referenceId)).find(Boolean);
    if (!e?.category) return r;
    return {
      ...r,
      category: {
        slug: e.category,
        name: e.categoryName || e.category,
        ...(e.subcategory ? { subcategory: e.subcategory, subcategoryName: e.subcategoryName || e.subcategory } : {}),
        fromExpense: true,
      },
    };
  });
}

/**
 * The category to save on a line (2026-10-22): checked against the organization's expense categories, and only on
 * money going out — money in, or "", has none.
 */
async function lineCategory(orgId: string, amountMinor: number, category: string | undefined, subcategory: string | undefined) {
  const none = { category: null, categoryName: "", subcategory: null, subcategoryName: "" };
  if (!category?.trim()) return none;
  if (amountMinor >= 0) throw new AppError("VALIDATION_ERROR", "A category is for money paid out — leave it empty on money coming in");
  const { resolveExpenseCategory } = await import("../expense-category/expense-category.service");
  const c = await resolveExpenseCategory(orgId, category.trim(), subcategory);
  return { category: c.category, categoryName: c.categoryName, subcategory: c.subcategory, subcategoryName: c.subcategoryName };
}

/** The line's side of a transfer, if it is one (2026-10-22). */
function transferView(doc: BankTransactionDoc): { transfer?: BankTransactionDTO["transfer"] } {
  const t = (doc as unknown as { transfer?: Record<string, unknown> | null }).transfer;
  if (!t?.id) return {};
  return {
    transfer: {
      id: String(t.id),
      direction: (doc.amountMinor as number) < 0 ? "out" : "in",
      otherAccountId: String(t.otherAccountId),
      otherAccountName: String(t.otherAccountName ?? ""),
      otherTransactionId: String(t.otherTransactionId),
      otherAmountMinor: Number(t.otherAmountMinor ?? 0),
      otherCurrency: String(t.otherCurrency ?? ""),
    },
  };
}

/** A transfer's line is changed as the transfer — both sides together — never on its own. */
function refuseTransferLine(tx: unknown): void {
  const t = (tx as { transfer?: { id?: unknown; otherAccountName?: string } | null }).transfer;
  if (t?.id) {
    throw new AppError("CONFLICT", `This line is one side of a transfer with ${t.otherAccountName ?? "another account"} — change or delete it as a transfer, so both sides move together.`);
  }
}

/**
 * A session's statement dates as the screen reads them. A document gives a Map; a lean read (the history list) gives a
 * plain object — both, and none on an older session.
 */
function statementDatesView(v: unknown): Record<string, string> {
  if (!v) return {};
  const entries = v instanceof Map ? [...v.entries()] : Object.entries(v as Record<string, unknown>);
  return Object.fromEntries(entries.filter(([, d]) => d).map(([k, d]) => [k, dateOnly(new Date(d as Date))]));
}

function sessionToDTO(doc: ReconciliationSessionDoc): ReconciliationSessionDTO {
  return {
    id: doc._id.toString(),
    accountId: doc.accountId.toString(),
    accountName: doc.accountName,
    currency: doc.currency,
    statementDate: dateOnly(doc.statementDate as unknown as Date),
    statementBalanceMinor: doc.statementBalanceMinor,
    ...((doc as unknown as { periodFrom?: Date }).periodFrom ? { periodFrom: dateOnly((doc as unknown as { periodFrom: Date }).periodFrom) } : {}),
    ...((doc as unknown as { periodTo?: Date }).periodTo ? { periodTo: dateOnly((doc as unknown as { periodTo: Date }).periodTo) } : {}),
    openingBookBalanceMinor: doc.openingBookBalanceMinor,
    closingBookBalanceMinor: doc.closingBookBalanceMinor,
    differenceMinor: doc.differenceMinor,
    status: doc.status as ReconciliationSessionDTO["status"],
    adjustmentTransactionId:
      (doc as unknown as { adjustmentTransactionId?: string }).adjustmentTransactionId ?? undefined,
    reconciledTransactionIds: (doc.reconciledTransactionIds as unknown as Types.ObjectId[]).map(
      (id) => id.toString(),
    ),
    statementDates: statementDatesView((doc as unknown as { statementDates?: unknown }).statementDates),
    completedAt: doc.completedAt
      ? (doc.completedAt as unknown as Date).toISOString()
      : undefined,
    completedByName: (doc.completedByName as string | undefined) ?? undefined,
    notes: (doc.notes as string) ?? "",
    createdAt: (doc as unknown as { createdAt: Date }).createdAt.toISOString(),
  };
}

// ── Bank Accounts ────────────────────────────────────────────────────────────

export async function createBankAccount(
  orgId: string,
  input: CreateBankAccountInput,
): Promise<BankAccountDTO> {
  const doc = await BankAccount.create({
    organizationId: new Types.ObjectId(orgId),
    ...input,
    openingDate: new Date(input.openingDate),
    currentBalanceMinor: input.openingBalanceMinor ?? 0,
  });
  return accountToDTO(doc);
}

export async function updateBankAccount(
  orgId: string,
  id: string,
  input: UpdateBankAccountInput,
): Promise<BankAccountDTO> {
  const update: Record<string, unknown> = { ...input };
  if (input.openingDate) update.openingDate = new Date(input.openingDate);
  const doc = await BankAccount.findOneAndUpdate(
    { _id: new Types.ObjectId(id), organizationId: new Types.ObjectId(orgId) },
    { $set: update },
    { new: true },
  );
  if (!doc) throw new AppError("NOT_FOUND", "Bank account not found");

  /*
   * Every balance below the opening one is measured from it.
   *
   * The opening figure could always be changed through this endpoint, and
   * changing it moved nothing else — so the cash book showed a new opening
   * balance with the old running balances underneath, and a closing balance
   * that no longer followed from the rows above it. The date matters for the
   * same reason: the running total is accumulated in date order, so moving the
   * opening date can reorder what comes after it.
   */
  const openingChanged =
    input.openingBalanceMinor !== undefined || input.openingDate !== undefined;
  if (openingChanged) {
    await recalculateRunningBalances(orgId, doc._id as Types.ObjectId);
    const fresh = await BankAccount.findById(doc._id);
    if (fresh) return accountToDTO(fresh);
  }

  return accountToDTO(doc);
}

export async function getBankAccount(orgId: string, id: string): Promise<BankAccountDTO> {
  const doc = await BankAccount.findOne({
    _id: new Types.ObjectId(id),
    organizationId: new Types.ObjectId(orgId),
  });
  if (!doc) throw new AppError("NOT_FOUND", "Bank account not found");
  return accountToDTO(doc);
}

const ACCOUNT_SORT: Record<string, string> = {
  name: "accountName",
  type: "accountType",
  currency: "currency",
  balance: "currentBalanceMinor",
  createdAt: "createdAt",
};

export async function listBankAccounts(
  orgId: string,
  query: BankAccountQuery,
): Promise<Paginated<BankAccountDTO>> {
  const { page, pageSize, sort, dir, q, accountType, isActive, currency } = query;
  const filter: Record<string, unknown> = {
    organizationId: new Types.ObjectId(orgId),
  };
  if (accountType) filter.accountType = accountType;
  if (isActive !== undefined) filter.isActive = isActive;
  if (currency) filter.currency = currency;
  const orClauses = searchOr(q, ["accountName", "bankName", "accountNumber"]);
  if (orClauses) Object.assign(filter, { $or: orClauses });

  const [docs, total] = await Promise.all([
    BankAccount.find(filter)
      .sort(buildSort(ACCOUNT_SORT, sort, dir, { createdAt: -1 }))
      .skip(skipFor(page, pageSize))
      .limit(pageSize)
      .lean(),
    BankAccount.countDocuments(filter),
  ]);
  return {
    data: (docs as unknown as BankAccountDoc[]).map(accountToDTO),
    meta: pageMeta(total, page, pageSize),
  };
}

export async function deactivateBankAccount(
  orgId: string,
  id: string,
): Promise<BankAccountDTO> {
  const doc = await BankAccount.findOneAndUpdate(
    { _id: new Types.ObjectId(id), organizationId: new Types.ObjectId(orgId) },
    { $set: { isActive: false } },
    { new: true },
  );
  if (!doc) throw new AppError("NOT_FOUND", "Bank account not found");
  return accountToDTO(doc);
}

// ── Bank Transactions ─────────────────────────────────────────────────────────

async function getLastRunningBalance(orgId: string, accountId: string): Promise<number> {
  const account = await BankAccount.findOne({
    _id: new Types.ObjectId(accountId),
    organizationId: new Types.ObjectId(orgId),
  }).lean();
  if (!account) throw new AppError("NOT_FOUND", "Bank account not found");
  return (account as unknown as { currentBalanceMinor: number }).currentBalanceMinor;
}

/**
 * Restate the running balance down an account, and the account's own balance.
 *
 * Called after anything that changes an amount or a date — an insert, an edit,
 * a deletion. A transaction's running balance is the account's balance as at
 * that point in the statement, so it belongs to the sequence rather than to the
 * row, and a single correction moves every figure below it.
 *
 * Writes only the rows that actually moved, so correcting something recent in a
 * long history touches a handful of documents rather than all of them.
 */
export async function recalculateRunningBalances(
  orgId: string,
  accountId: Types.ObjectId,
): Promise<number> {
  const account = await BankAccount.findOne({ _id: accountId, organizationId: new Types.ObjectId(orgId) });
  if (!account) throw new AppError("NOT_FOUND", "Bank account not found");

  const txs = await BankTransaction.find({ accountId, organizationId: new Types.ObjectId(orgId) })
    .select("date amountMinor runningBalanceMinor createdAt")
    .lean();

  const rows: BalanceRow[] = txs.map((t) => ({
    id: String(t._id),
    dateMs: new Date(t.date).getTime(),
    // Insertion order as the tiebreak within a day. `_id` is monotonic when
    // createdAt is missing on rows written before timestamps were added.
    seq: t.createdAt ? new Date(t.createdAt as Date).getTime() : 0,
    amountMinor: t.amountMinor,
    runningBalanceMinor: t.runningBalanceMinor ?? 0,
  }));

  const { changed, closingBalanceMinor } = computeRunningBalances(account.openingBalanceMinor ?? 0, rows);

  if (changed.length) {
    await BankTransaction.bulkWrite(
      changed.map((c) => ({
        updateOne: {
          filter: { _id: new Types.ObjectId(c.id) },
          update: { $set: { runningBalanceMinor: c.runningBalanceMinor } },
        },
      })),
    );
  }
  await BankAccount.updateOne({ _id: accountId }, { $set: { currentBalanceMinor: closingBalanceMinor } });
  return closingBalanceMinor;
}

/**
 * Whether a transaction is still somebody's to change.
 *
 * Two things put it beyond reach. A reconciled row is evidence: it was signed
 * off against a statement balance, and altering it would quietly invalidate
 * that sign-off with nothing to show for it. A matched row belongs to the
 * document it was matched to — a payroll payment records the transaction it
 * created, so deleting it here would leave that payment pointing at nothing and
 * its reversal unable to give the money back.
 */
// Return type inferred from findOne, so the caller gets a hydrated document it
// can save rather than the plain shape BankTransactionDoc describes.
export async function assertEditable(orgId: string, accountId: string, txId: string) {
  const tx = await BankTransaction.findOne({
    _id: new Types.ObjectId(txId),
    accountId: new Types.ObjectId(accountId),
    organizationId: new Types.ObjectId(orgId),
  });
  if (!tx) throw new AppError("NOT_FOUND", "Transaction not found");

  /*
   * A reconciled bank transaction is evidence: it was ticked off against a
   * statement the bank issued, and changing it afterwards would contradict a
   * document we do not control.
   *
   * A tin is not that. Its "statement" is a figure somebody counted, and the
   * count can be withdrawn and taken again by the same person who keeps the
   * cash — so a mistyped entry stays correctable, and the count above it is the
   * thing that has to be redone rather than the reason it cannot be.
   */
  const account = await BankAccount.findOne({
    _id: new Types.ObjectId(accountId),
    organizationId: new Types.ObjectId(orgId),
  }).select("accountType");
  const isTin = account?.accountType === "petty_cash";

  if (tx.isReconciled && !isTin) {
    throw new AppError(
      "CONFLICT",
      "This transaction has been reconciled and can no longer be changed. Add a correcting entry instead.",
    );
  }
  if (tx.matches?.length) {
    const m = tx.matches[0]!;
    throw new AppError(
      "CONFLICT",
      `This transaction is matched to ${m.type} ${m.referenceNumber}. Unmatch it first, or change it from there.`,
    );
  }
  return tx;
}

/** Correct an entry. Only what somebody typed; the rest is derived. */
export async function updateTransaction(
  orgId: string,
  accountId: string,
  txId: string,
  input: UpdateBankTransactionInput,
  /** Who is typing — only the Banking screen passes it: a line moved to an old date waits for a manager. */
  late?: LateActor,
): Promise<BankTransactionDTO> {
  const tx = await assertEditable(orgId, accountId, txId);
  refuseTransferLine(tx);

  const lateNow = input.date !== undefined && tx.source === "manual"
    ? await lateForDate(orgId, late ? { ...late, reason: input.lateReason ?? late.reason } : undefined, input.date, tx.date as Date, (tx as any).lateEntry)
    : null;
  if (lateNow && lateNow.next !== undefined) (tx as any).lateEntry = lateNow.next;
  if (input.date !== undefined) tx.date = new Date(input.date);
  if (input.description !== undefined) tx.description = input.description;
  if (input.reference !== undefined) tx.reference = input.reference;
  if (input.notes !== undefined) tx.notes = input.notes;
  if (input.amountMinor !== undefined) {
    tx.amountMinor = input.amountMinor;
    // Direction follows the sign, exactly as it does on the way in.
    tx.type = input.amountMinor >= 0 ? "credit" : "debit";
  }
  // Given, it is checked; a line that turns into money coming in loses one it had.
  const t = tx as unknown as { category?: string | null; subcategory?: string | null };
  if (input.category !== undefined) {
    Object.assign(tx, await lineCategory(orgId, tx.amountMinor, input.category, input.subcategory));
  } else if (t.category && tx.amountMinor >= 0) {
    Object.assign(tx, await lineCategory(orgId, tx.amountMinor, "", undefined));
  }
  await tx.save();
  if (lateNow?.pending) await openLateEntry(orgId, lateNow.pending, bankLateInfo(tx));
  else if (lateNow?.withdraw) await withdrawLateFor(orgId, "bank_line", tx._id);

  await recalculateRunningBalances(orgId, tx.accountId as Types.ObjectId);

  const fresh = await BankTransaction.findById(tx._id);
  return txToDTO(fresh!);
}

/** A bank / cash line as its late entry describes it. */
function bankLateInfo(tx: any) {
  return {
    kind: "bank_line" as const, refId: tx._id, accountId: tx.accountId, number: String(tx.reference || "Bank line"),
    title: `${tx.accountName} · ${tx.description}`, amountMinor: (tx.type === "debit" ? -1 : 1) * Math.abs(tx.amountMinor ?? 0), currency: String(tx.currency ?? "AED"),
  };
}

/** Remove an entry that should never have been there. */
/** A tin runs on paper, and ten slips is plenty for one entry. */
const MAX_TX_ATTACHMENTS = 10;

/**
 * Attach the receipt behind an entry.
 *
 * Held to the same rule as changing one: whatever may be edited may have its
 * paperwork corrected, and a matched entry belongs to the document it was
 * matched to.
 */
export async function addTransactionAttachment(
  orgId: string,
  accountId: string,
  txId: string,
  file: { buffer: Buffer; originalName: string; mimeType: string },
): Promise<BankTransactionDTO> {
  const tx = await assertEditable(orgId, accountId, txId);

  const existing = ((tx as unknown as { attachments?: unknown[] }).attachments ?? []);
  if (existing.length >= MAX_TX_ATTACHMENTS) {
    throw new AppError("CONFLICT", `An entry can hold at most ${MAX_TX_ATTACHMENTS} receipts`);
  }

  const { uploadFile, storageConfigured } = await import("../../lib/storage");
  if (!storageConfigured()) throw new AppError("VALIDATION_ERROR", "File storage is not configured");

  // The uploader's filename never becomes the key: it is theirs to choose, and
  // a key built from it could reach outside this entry's prefix.
  const safe = file.originalName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  const uploaded = await uploadFile({
    key: `bank-transactions/${orgId}/${txId}/${Date.now()}-${safe}`,
    buffer: file.buffer,
    mimeType: file.mimeType,
    originalName: file.originalName,
  });

  (existing as Record<string, unknown>[]).push({
    name: file.originalName.slice(0, 200),
    url: uploaded.url,
    key: uploaded.key,
    size: uploaded.size,
    mimeType: uploaded.mimeType,
    uploadedAt: new Date(),
  });
  tx.set("attachments", existing);
  await tx.save();
  return txToDTO(tx as unknown as BankTransactionDoc);
}

export async function removeTransactionAttachment(
  orgId: string,
  accountId: string,
  txId: string,
  key: string,
): Promise<BankTransactionDTO> {
  const tx = await assertEditable(orgId, accountId, txId);
  const list = ((tx as unknown as { attachments?: { key?: string }[] }).attachments ?? []);
  const idx = list.findIndex((a) => a.key === key);
  if (idx === -1) throw new AppError("NOT_FOUND", "Receipt not found");

  const [removed] = list.splice(idx, 1);
  tx.set("attachments", list);
  await tx.save();

  // The row going is what was asked for; the object staying is untidiness, not
  // a reason to fail and leave the row behind.
  if (removed?.key) {
    try {
      const { deleteFile } = await import("../../lib/storage");
      await deleteFile(removed.key);
    } catch (err) {
      const { logger } = await import("../../lib/logger");
      logger.error({ err, key: removed.key }, "Removed a receipt but could not delete the object");
    }
  }
  return txToDTO(tx as unknown as BankTransactionDoc);
}

export async function deleteTransaction(
  orgId: string,
  accountId: string,
  txId: string,
): Promise<void> {
  const tx = await assertEditable(orgId, accountId, txId);
  refuseTransferLine(tx);
  const account = tx.accountId as Types.ObjectId;
  await BankTransaction.deleteOne({ _id: tx._id });
  await withdrawLateFor(orgId, "bank_line", tx._id);
  await recalculateRunningBalances(orgId, account);
}

export async function addTransaction(
  orgId: string,
  accountId: string,
  input: CreateBankTransactionInput,
  source: "manual" | "import" = "manual",
  importBatchId?: string,
  /** Who is typing — only the Banking screen passes it: a line dated back waits for a manager (2026-10-21). */
  late?: LateActor,
): Promise<BankTransactionDTO> {
  const account = await BankAccount.findOne({
    _id: new Types.ObjectId(accountId),
    organizationId: new Types.ObjectId(orgId),
  });
  if (!account) throw new AppError("NOT_FOUND", "Bank account not found");

  const txType = input.amountMinor >= 0 ? "credit" : "debit";
  const category = await lineCategory(orgId, input.amountMinor, input.category, input.subcategory);
  const lateNow = source === "manual"
    ? await lateForDate(orgId, late ? { ...late, reason: input.lateReason ?? late.reason } : undefined, input.date, null, null)
    : null;

  const doc = await BankTransaction.create({
    organizationId: new Types.ObjectId(orgId),
    accountId: new Types.ObjectId(accountId),
    accountName: account.accountName,
    currency: account.currency,
    date: new Date(input.date),
    description: input.description,
    reference: input.reference ?? "",
    amountMinor: input.amountMinor,
    type: txType,
    // Filled in by the recompute below, which places the row by its date rather
    // than assuming it belongs at the end. Entering a back-dated transaction
    // used to stamp it with today's closing balance and leave every row after
    // it unchanged, so the column stopped agreeing with itself.
    runningBalanceMinor: 0,
    source,
    importBatchId: importBatchId ?? undefined,
    notes: input.notes ?? "",
    lateEntry: lateNow?.next ?? null,
    ...category,
  });
  if (lateNow?.pending) await openLateEntry(orgId, lateNow.pending, bankLateInfo(doc));

  await recalculateRunningBalances(orgId, account._id);

  const fresh = await BankTransaction.findById(doc._id);
  return txToDTO(fresh!);
}

/**
 * Statement lines already sitting on this account, keyed by fingerprint.
 *
 * Scoped to the date range being imported rather than the whole account: a
 * statement covers a month, and a year of history is not worth scanning to
 * check it.
 */
async function existingKeys(
  orgId: string,
  accountId: Types.ObjectId,
  isoDates: string[],
  externalIds: string[],
): Promise<Set<string>> {
  const sorted = [...isoDates].sort();
  const from = new Date(`${sorted[0]}T00:00:00.000Z`);
  const to = new Date(`${sorted[sorted.length - 1]}T23:59:59.999Z`);

  // Two reads with different reach. The date window covers the statement
  // period, which is what a fingerprint needs. A bank reference identifies a
  // transaction wherever it sits, and a bank re-issuing a statement with
  // corrected dates would slip past a window — so those are looked up by id.
  const [inWindow, byRef] = await Promise.all([
    BankTransaction.find({
      organizationId: new Types.ObjectId(orgId),
      accountId,
      date: { $gte: from, $lte: to },
    }).select("date amountMinor description reference externalId"),
    externalIds.length
      ? BankTransaction.find({
          organizationId: new Types.ObjectId(orgId),
          accountId,
          externalId: { $in: externalIds },
        }).select("date amountMinor description reference externalId")
      : Promise.resolve([]),
  ]);

  const keys = new Set<string>();
  for (const r of [...inWindow, ...byRef]) {
    keys.add(
      fingerprint({
        isoDate: (r.date as Date).toISOString().slice(0, 10),
        amountMinor: r.amountMinor as number,
        description: r.description as string,
        reference: (r.reference as string) ?? "",
      }),
    );
    const ext = r.externalId as string | undefined;
    if (ext) keys.add(`ext|${ext}`);
  }
  return keys;
}

/**
 * How one incoming line is recognised.
 *
 * The bank's own reference when there is one, because it identifies the
 * transaction outright — two separate payments of the same amount on the same
 * day are otherwise indistinguishable. Everything else falls back to the
 * fingerprint.
 */
function lineKey(tx: {
  date: string;
  amountMinor: number;
  description: string;
  reference?: string;
  externalId?: string;
}) {
  if (tx.externalId) return `ext|${tx.externalId}`;
  return fingerprint({
    isoDate: tx.date,
    amountMinor: tx.amountMinor,
    description: tx.description,
    reference: tx.reference ?? "",
  });
}

/**
 * Which lines are already on the account, without writing anything.
 *
 * Lets the wizard say "12 of these 40 are already here" while the import can
 * still be called off, rather than reporting it once it is too late.
 */
export async function previewImport(
  orgId: string,
  accountId: string,
  input: PreviewImportInput,
): Promise<{ total: number; duplicates: number[]; newCount: number }> {
  const account = await BankAccount.findOne({
    _id: new Types.ObjectId(accountId),
    organizationId: new Types.ObjectId(orgId),
  });
  if (!account) throw new AppError("NOT_FOUND", "Bank account not found");

  const seen = await existingKeys(
    orgId,
    account._id,
    input.transactions.map((t) => t.date),
    input.transactions.map((t) => t.externalId).filter((v): v is string => Boolean(v)),
  );

  // Repeats inside the file itself count too — a statement pasted together
  // from two exports has them, and they are duplicates just the same.
  const withinBatch = new Set<string>();
  const duplicates: number[] = [];
  input.transactions.forEach((tx, i) => {
    const fp = lineKey(tx);
    if (seen.has(fp) || withinBatch.has(fp)) duplicates.push(i);
    withinBatch.add(fp);
  });

  return {
    total: input.transactions.length,
    duplicates,
    newCount: input.transactions.length - duplicates.length,
  };
}

export async function bulkImportTransactions(
  orgId: string,
  accountId: string,
  input: BulkImportTransactionsInput,
): Promise<{ count: number; skipped: number; transactions: BankTransactionDTO[] }> {
  const account = await BankAccount.findOne({
    _id: new Types.ObjectId(accountId),
    organizationId: new Types.ObjectId(orgId),
  });
  if (!account) throw new AppError("NOT_FOUND", "Bank account not found");

  const seen = await existingKeys(
    orgId,
    account._id,
    input.transactions.map((t) => t.date),
    input.transactions.map((t) => t.externalId).filter((v): v is string => Boolean(v)),
  );
  const withinBatch = new Set<string>();

  const toInsert: typeof input.transactions = [];
  let skipped = 0;
  for (const tx of input.transactions) {
    const fp = lineKey(tx);
    const duplicate = seen.has(fp) || withinBatch.has(fp);
    withinBatch.add(fp);

    // A matching bank reference is not a resemblance, it is the same
    // transaction — the bank issues one per transaction. "Import anyway" is
    // offered for lines that merely look alike, and does not apply here.
    // Letting it through would also collide with the unique index.
    const definite = duplicate && Boolean(tx.externalId);

    if (duplicate && (definite || input.onDuplicate === "skip")) {
      skipped++;
      continue;
    }
    toInsert.push({ ...tx, __duplicate: duplicate } as typeof tx & { __duplicate: boolean });
  }

  if (toInsert.length === 0) {
    return { count: 0, skipped, transactions: [] };
  }

  const sorted = [...toInsert].sort((a, b) => a.date.localeCompare(b.date));
  const batchId = input.importBatchId ?? new Types.ObjectId().toString();

  const docs = sorted.map((tx) => ({
    organizationId: new Types.ObjectId(orgId),
    accountId: new Types.ObjectId(accountId),
    accountName: account.accountName as string,
    currency: account.currency as string,
    // Midday UTC, so the calendar day the statement shows survives being
    // rendered in a timezone either side of UTC. Midnight does not.
    date: new Date(`${tx.date}T12:00:00.000Z`),
    description: tx.description,
    reference: tx.reference ?? "",
    externalId: tx.externalId || undefined,
    amountMinor: tx.amountMinor,
    type: tx.amountMinor >= 0 ? ("credit" as const) : ("debit" as const),
    // Restated below across the whole account; a placeholder until then.
    runningBalanceMinor: 0,
    source: "import" as const,
    importBatchId: batchId,
    // Brought in knowingly over a match, so it is marked rather than left to
    // look like an ordinary unreconciled line.
    status: (tx as { __duplicate?: boolean }).__duplicate
      ? ("duplicate" as const)
      : ("unmatched" as const),
    notes: tx.notes ?? "",
  }));

  // Unordered, so a row losing a race against a concurrent import of the same
  // statement does not abort the rest. The unique index is the authority on
  // what got in; anything it rejected was already there.
  let inserted: BankTransactionDoc[];
  try {
    inserted = (await BankTransaction.insertMany(docs, {
      ordered: false,
    })) as unknown as BankTransactionDoc[];
  } catch (err) {
    const bulk = err as { insertedDocs?: BankTransactionDoc[]; code?: number; writeErrors?: unknown[] };
    // Duplicate-key rejections are the expected outcome of that race and are
    // counted as skipped. Anything else is a real failure.
    const onlyDuplicates =
      Array.isArray(bulk.writeErrors) &&
      bulk.writeErrors.every((e) => (e as { err?: { code?: number } })?.err?.code === 11000);
    if (!bulk.insertedDocs || !onlyDuplicates) throw err;
    inserted = bulk.insertedDocs;
    skipped += docs.length - inserted.length;
  }

  // The running balance is a property of the account in date order, not of this
  // batch. A statement that overlaps existing entries needs the whole column
  // restated, so it is always recomputed rather than continued from the end.
  await recalculateRunningBalances(orgId, account._id);

  const fresh = await BankTransaction.find({ _id: { $in: inserted.map((d) => d._id) } });

  return {
    count: inserted.length,
    skipped,
    transactions: fresh.map(txToDTO),
  };
}

export async function getTransaction(orgId: string, id: string): Promise<BankTransactionDTO> {
  const doc = await BankTransaction.findOne({
    _id: new Types.ObjectId(id),
    organizationId: new Types.ObjectId(orgId),
  });
  if (!doc) throw new AppError("NOT_FOUND", "Transaction not found");
  return txToDTO(doc);
}

/** Append creation order, and then id, so a sort is never ambiguous. */
export function withTiebreak(sort: Record<string, 1 | -1>): Record<string, 1 | -1> {
  const dir = Object.values(sort)[0] ?? 1;
  return { ...sort, createdAt: sort.createdAt ?? dir, _id: sort._id ?? dir };
}

const TX_SORT: Record<string, string> = {
  date: "date",
  description: "description",
  amount: "amountMinor",
  balance: "runningBalanceMinor",
  status: "status",
  createdAt: "createdAt",
};

export async function listTransactions(
  orgId: string,
  accountId: string,
  query: BankTransactionQuery,
): Promise<Paginated<BankTransactionDTO>> {
  const { page, pageSize, sort, dir, q, status, dateFrom, dateTo, isReconciled, source, category, subcategory } = query;
  const filter: Record<string, unknown> = {
    organizationId: new Types.ObjectId(orgId),
    accountId: new Types.ObjectId(accountId),
  };
  if (status) filter.status = status;
  if (isReconciled !== undefined) filter.isReconciled = isReconciled;
  if (source) filter.source = source;
  if (dateFrom || dateTo) {
    const dateFilter: Record<string, Date> = {};
    if (dateFrom) dateFilter.$gte = new Date(dateFrom);
    if (dateTo) dateFilter.$lte = new Date(dateTo + "T23:59:59.999Z");
    filter.date = dateFilter;
  }
  const and: Record<string, unknown>[] = [];
  const orClauses = searchOr(q, ["description", "reference"]);
  if (orClauses) and.push({ $or: orClauses });
  // What it was for (2026-10-22): its own category, or that of the expense that made it. "none": money paid out
  // that says nothing — not an expense's, not a transfer.
  if (category === "none") {
    and.push({ amountMinor: { $lt: 0 }, category: null, transfer: null, matches: { $not: { $elemMatch: { type: "expense" } } } });
  } else if (category) {
    const own: Record<string, unknown> = { category, ...(subcategory ? { subcategory } : {}) };
    const { Expense } = await import("../expense/expense.model");
    const lines = await Expense.find({ organizationId: new Types.ObjectId(orgId), category, ...(subcategory ? { subcategory } : {}), bankAccountId: new Types.ObjectId(accountId), bankTransactionId: { $ne: null } })
      .distinct("bankTransactionId");
    and.push({ $or: [own, { _id: { $in: lines } }] });
  }
  if (and.length) filter.$and = and;

  const [docs, total] = await Promise.all([
    BankTransaction.find(filter)
      /*
       * Ties broken by creation order, in the same direction.
       *
       * A cash book puts several entries on one day, and sorting by date alone
       * left the database free to return them in any order it liked — while the
       * running balance is worked out with creation order as the tiebreak. The
       * two disagreed, so the balance column read as nonsense even though every
       * figure in it was right. It also makes paging deterministic: without a
       * tiebreak a row can appear on two pages, or on none.
       */
      .sort(withTiebreak(buildSort(TX_SORT, sort, dir, { date: -1 })))
      .skip(skipFor(page, pageSize))
      .limit(pageSize)
      .lean(),
    BankTransaction.countDocuments(filter),
  ]);
  return {
    data: await withExpenseCategories(orgId, (docs as unknown as BankTransactionDoc[]).map(txToDTO)),
    meta: pageMeta(total, page, pageSize),
  };
}

export async function matchTransaction(
  orgId: string,
  id: string,
  input: MatchTransactionInput,
): Promise<BankTransactionDTO> {
  const doc = await BankTransaction.findOneAndUpdate(
    { _id: new Types.ObjectId(id), organizationId: new Types.ObjectId(orgId) },
    {
      $set: { status: "matched" },
      $push: { matches: input },
    },
    { new: true },
  );
  if (!doc) throw new AppError("NOT_FOUND", "Transaction not found");
  return txToDTO(doc);
}

export async function unmatchTransaction(
  orgId: string,
  id: string,
): Promise<BankTransactionDTO> {
  const doc = await BankTransaction.findOneAndUpdate(
    { _id: new Types.ObjectId(id), organizationId: new Types.ObjectId(orgId) },
    { $set: { status: "unmatched", matches: [] } },
    { new: true },
  );
  if (!doc) throw new AppError("NOT_FOUND", "Transaction not found");
  return txToDTO(doc);
}

export async function excludeTransaction(
  orgId: string,
  id: string,
): Promise<BankTransactionDTO> {
  const doc = await BankTransaction.findOneAndUpdate(
    { _id: new Types.ObjectId(id), organizationId: new Types.ObjectId(orgId) },
    { $set: { status: "excluded" } },
    { new: true },
  );
  if (!doc) throw new AppError("NOT_FOUND", "Transaction not found");
  return txToDTO(doc);
}

/**
 * Undo an exclusion or a duplicate flag.
 *
 * Both were one-way: a row marked in error stayed marked, with nothing on the
 * screen offering a way back. The status returns to what it would have been —
 * matched if the transaction still points at a document, unmatched otherwise —
 * rather than to a fixed value, so restoring a matched row does not quietly
 * disown the invoice it was matched to.
 */
export async function restoreTransaction(orgId: string, id: string): Promise<BankTransactionDTO> {
  const tx = await BankTransaction.findOne({
    _id: new Types.ObjectId(id),
    organizationId: new Types.ObjectId(orgId),
  });
  if (!tx) throw new AppError("NOT_FOUND", "Transaction not found");

  if (tx.status !== "excluded" && tx.status !== "duplicate") {
    throw new AppError("CONFLICT", "Only an excluded or duplicate transaction can be restored");
  }

  tx.status = tx.matches?.length ? "matched" : "unmatched";
  await tx.save();
  return txToDTO(tx);
}

export async function markDuplicate(orgId: string, id: string): Promise<BankTransactionDTO> {
  const doc = await BankTransaction.findOneAndUpdate(
    { _id: new Types.ObjectId(id), organizationId: new Types.ObjectId(orgId) },
    { $set: { status: "duplicate" } },
    { new: true },
  );
  if (!doc) throw new AppError("NOT_FOUND", "Transaction not found");
  return txToDTO(doc);
}

// ── Reconciliation ────────────────────────────────────────────────────────────

export async function startReconciliation(
  orgId: string,
  accountId: string,
  input: StartReconciliationInput,
): Promise<ReconciliationSessionDTO> {
  const account = await BankAccount.findOne({
    _id: new Types.ObjectId(accountId),
    organizationId: new Types.ObjectId(orgId),
  });
  if (!account) throw new AppError("NOT_FOUND", "Bank account not found");

  if (await ReconciliationSession.exists({ organizationId: new Types.ObjectId(orgId), accountId: new Types.ObjectId(accountId), status: "open" })) {
    throw new AppError("CONFLICT", "A reconciliation of this account is open already — complete it first");
  }

  // A period (2026-10-23): it can't start before the last completed reconciliation ends — no line is reconciled twice.
  if (input.periodFrom && input.periodTo) {
    const reconciledTo = await lastReconciledDay(orgId, accountId);
    if (reconciledTo && input.periodFrom <= reconciledTo) {
      throw new AppError("VALIDATION_ERROR", `This account is reconciled up to ${reconciledTo} — start the period on ${nextDay(reconciledTo)} or later`);
    }
    if (input.statementDate < input.periodTo) throw new AppError("VALIDATION_ERROR", "The statement date can't be before the period's last day");
  }

  const openingBalance = input.openingBalanceMinor
    ?? (input.periodFrom ? (await reconciliationOpening(orgId, accountId, input.periodFrom)).openingBalanceMinor : undefined)
    ?? (account.lastReconciledStatementBalanceMinor as number | undefined)
    ?? (account.openingBalanceMinor as number) ?? 0;

  // Nothing ticked yet: the book stands at the opening balance (a period's) or the account's balance (as before).
  const closingBookBalance = input.periodFrom ? openingBalance : (account.currentBalanceMinor as number) ?? 0;
  const differenceMinor = input.statementBalanceMinor - closingBookBalance;

  const doc = await ReconciliationSession.create({
    organizationId: new Types.ObjectId(orgId),
    accountId: new Types.ObjectId(accountId),
    accountName: account.accountName,
    currency: account.currency,
    statementDate: new Date(input.statementDate),
    statementBalanceMinor: input.statementBalanceMinor,
    ...(input.periodFrom && input.periodTo ? { periodFrom: new Date(`${input.periodFrom}T00:00:00.000Z`), periodTo: new Date(`${input.periodTo}T00:00:00.000Z`) } : {}),
    openingBookBalanceMinor: openingBalance,
    closingBookBalanceMinor: closingBookBalance,
    differenceMinor,
    notes: input.notes ?? "",
  });
  return sessionToDTO(doc);
}

const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const prevDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/** The last day the account's completed reconciliations cover (a period's end, else an older one's statement date). */
async function lastReconciledDay(orgId: string, accountId: string): Promise<string | null> {
  const done = await ReconciliationSession.find({ organizationId: new Types.ObjectId(orgId), accountId: new Types.ObjectId(accountId), status: "completed" })
    .select("periodTo statementDate").lean<Array<{ periodTo?: Date; statementDate: Date }>>();
  const ends = done.map((s) => dateOnly(s.periodTo ?? s.statementDate)).sort();
  return ends.at(-1) ?? null;
}

/**
 * What a period starting on `periodFrom` opens at (2026-10-23): the closing balance of a completed reconciliation that
 * ends the day before, else the book — the running balance after the last line before that day (the opening balance
 * when there is none). The Reconcile screen fills it in; the person changes it to the statement's own figure.
 */
export async function reconciliationOpening(orgId: string, accountId: string, periodFrom: string): Promise<ReconciliationOpening> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodFrom)) throw new AppError("VALIDATION_ERROR", "from is YYYY-MM-DD");
  const org = new Types.ObjectId(orgId), acc = new Types.ObjectId(accountId);
  const account = await BankAccount.findOne({ _id: acc, organizationId: org }).select("openingBalanceMinor").lean<{ openingBalanceMinor?: number }>();
  if (!account) throw new AppError("NOT_FOUND", "Bank account not found");
  const reconciledTo = await lastReconciledDay(orgId, accountId);
  const before = prevDay(periodFrom);
  const ending = await ReconciliationSession.findOne({
    organizationId: org, accountId: acc, status: "completed",
    $or: [{ periodTo: new Date(`${before}T00:00:00.000Z`) }, { periodTo: null, statementDate: new Date(`${before}T00:00:00.000Z`) }],
  }).sort({ completedAt: -1 }).select("statementBalanceMinor").lean<{ statementBalanceMinor: number }>();
  if (ending) return { periodFrom, openingBalanceMinor: ending.statementBalanceMinor, source: "last_reconciliation", reconciledTo };
  const last = await BankTransaction.findOne({ organizationId: org, accountId: acc, date: { $lt: new Date(`${periodFrom}T00:00:00.000Z`) } })
    .sort({ date: -1, _id: -1 }).select("runningBalanceMinor").lean<{ runningBalanceMinor?: number }>();
  return { periodFrom, openingBalanceMinor: last?.runningBalanceMinor ?? account.openingBalanceMinor ?? 0, source: "book", reconciledTo };
}

/**
 * The lines a session lists (2026-10-23): every unreconciled line of its period — `earlier` adds the unreconciled ones
 * before it, which cleared only on this statement — and whatever it has ticked. A session without a period lists every
 * unreconciled line, as before. Not paged (at most 3000).
 */
export async function reconciliationLines(orgId: string, sessionId: string, earlier: boolean, tickedOnly = false): Promise<BankTransactionDTO[]> {
  const session = await ReconciliationSession.findOne({ _id: new Types.ObjectId(sessionId), organizationId: new Types.ObjectId(orgId) }).lean<any>();
  if (!session) throw new AppError("NOT_FOUND", "Reconciliation session not found");
  // Only what it ticked — a completed reconciliation's lines, for the bank page's Reconciliations tab (2026-10-23).
  if (tickedOnly) {
    const ticked = await BankTransaction.find({ organizationId: session.organizationId, _id: { $in: session.reconciledTransactionIds ?? [] } })
      .sort({ date: 1, _id: 1 }).limit(3000).lean();
    return withExpenseCategories(orgId, (ticked as unknown as BankTransactionDoc[]).map(txToDTO));
  }
  const date: Record<string, Date> = {};
  if (session.periodTo) date.$lt = new Date(Date.parse(`${dateOnly(session.periodTo)}T00:00:00Z`) + 86_400_000);
  if (session.periodFrom && !earlier) date.$gte = new Date(`${dateOnly(session.periodFrom)}T00:00:00.000Z`);
  const docs = await BankTransaction.find({
    organizationId: session.organizationId, accountId: session.accountId,
    $or: [
      { isReconciled: { $ne: true }, ...(Object.keys(date).length ? { date } : {}) },
      { _id: { $in: session.reconciledTransactionIds ?? [] } },
    ],
  }).sort({ date: 1, _id: 1 }).limit(3000).lean();
  return withExpenseCategories(orgId, (docs as unknown as BankTransactionDoc[]).map(txToDTO));
}

export async function updateReconciliation(
  orgId: string,
  sessionId: string,
  input: UpdateReconciliationInput,
): Promise<ReconciliationSessionDTO> {
  const session = await ReconciliationSession.findOne({
    _id: new Types.ObjectId(sessionId),
    organizationId: new Types.ObjectId(orgId),
    status: "open",
  });
  if (!session) throw new AppError("NOT_FOUND", "Reconciliation session not found or already completed");

  const reconciledIds = input.reconciledTransactionIds.map((id) => new Types.ObjectId(id));
  const reconciledTxs = await BankTransaction.find({
    _id: { $in: reconciledIds },
    organizationId: new Types.ObjectId(orgId),
    accountId: session.accountId,
  }).lean();

  const reconciledTotal = (reconciledTxs as unknown as { amountMinor: number }[]).reduce(
    (sum, tx) => sum + tx.amountMinor,
    0,
  );
  const closingBookBalance = (session.openingBookBalanceMinor as number) + reconciledTotal;
  const differenceMinor = (session.statementBalanceMinor as number) - closingBookBalance;

  /* The statement's day for a ticked line, where it isn't the line's own (2026-10-23). Only for lines ticked in this
     session, and never after the statement's own date — a line can't be on a statement that ends before it. */
  const ticked = new Map((reconciledTxs as unknown as { _id: Types.ObjectId; date: Date }[]).map((t) => [String(t._id), t]));
  const statementEnd = dateOnly(session.statementDate as unknown as Date);
  const statementDates = new Map<string, Date>();
  for (const [id, day] of Object.entries(input.statementDates ?? {})) {
    const tx = ticked.get(id);
    if (!tx) continue;
    if (day > statementEnd) throw new AppError("VALIDATION_ERROR", `A statement date can't be after the statement's own date (${statementEnd})`);
    if (day !== dateOnly(tx.date)) statementDates.set(id, new Date(`${day}T00:00:00.000Z`));
  }

  const updated = await ReconciliationSession.findByIdAndUpdate(
    sessionId,
    {
      $set: {
        reconciledTransactionIds: reconciledIds,
        ...(input.statementDates !== undefined ? { statementDates } : {}),
        closingBookBalanceMinor: closingBookBalance,
        differenceMinor,
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      },
    },
    { new: true },
  );
  if (!updated) throw new AppError("NOT_FOUND", "Reconciliation session not found");
  return sessionToDTO(updated);
}

/**
 * The day the statement shows each line just reconciled (the user, 2026-10-23: "the statement date — only at the
 * bank reconcile time we can enter it"): the one given for it in the session, else its own date — on the line and on
 * the expense paid by it, whose Statement date stops being pending.
 */
async function writeStatementDates(orgId: string, ids: Types.ObjectId[], given: Map<string, Date> | undefined): Promise<void> {
  if (!ids.length) return;
  const org = new Types.ObjectId(orgId);
  const lines = await BankTransaction.find({ _id: { $in: ids }, organizationId: org }).select("date").lean<{ _id: Types.ObjectId; date: Date }[]>();
  if (!lines.length) return;
  const dayOf = (l: { _id: Types.ObjectId; date: Date }) => given?.get(String(l._id)) ?? new Date(`${dateOnly(l.date)}T00:00:00.000Z`);
  await BankTransaction.bulkWrite(lines.map((l) => ({ updateOne: { filter: { _id: l._id }, update: { $set: { statementDate: dayOf(l) } } } })));
  const { Expense } = await import("../expense/expense.model");
  await Expense.bulkWrite(lines.map((l) => ({
    updateMany: { filter: { organizationId: org, bankTransactionId: l._id }, update: { $set: { statementDate: dayOf(l) } } },
  })));
}

export async function completeReconciliation(
  orgId: string,
  sessionId: string,
  completedByName: string,
): Promise<ReconciliationSessionDTO> {
  const session = await ReconciliationSession.findOne({
    _id: new Types.ObjectId(sessionId),
    organizationId: new Types.ObjectId(orgId),
    status: "open",
  });
  if (!session) throw new AppError("NOT_FOUND", "Reconciliation session not found or already completed");

  const reconciledIds = (session.reconciledTransactionIds as unknown as Types.ObjectId[]);

  await BankTransaction.updateMany(
    {
      _id: { $in: reconciledIds },
      organizationId: new Types.ObjectId(orgId),
    },
    { $set: { isReconciled: true, reconciledSessionId: sessionId } },
  );
  await writeStatementDates(orgId, reconciledIds, (session as unknown as { statementDates?: Map<string, Date> }).statementDates);

  await BankAccount.updateOne(
    { _id: session.accountId, organizationId: new Types.ObjectId(orgId) },
    {
      $set: {
        lastReconciledAt: new Date(),
        lastReconciledStatementBalanceMinor: session.statementBalanceMinor,
      },
    },
  );

  const updated = await ReconciliationSession.findByIdAndUpdate(
    sessionId,
    {
      $set: {
        status: "completed",
        completedAt: new Date(),
        completedByName,
      },
    },
    { new: true },
  );
  if (!updated) throw new AppError("NOT_FOUND", "Reconciliation session not found");
  return sessionToDTO(updated);
}

/**
 * Count the tin, and make the book agree with what was counted.
 *
 * A count that records a disagreement and leaves it in place is not a count —
 * the next one starts from the same wrong figure. So the difference is posted
 * as an entry of its own, dated the day of the count, and the book balance ends
 * up equal to the cash.
 *
 * The session records what was found *before* that entry, because the whole
 * point of counting is knowing whether it agreed, and an adjustment that
 * happened after the fact must not erase the answer.
 *
 * Everything up to the day of the count is marked reconciled: a count settles
 * the whole tin, not a chosen subset of it, which is what makes it different
 * from ticking off a bank statement line by line.
 */
export async function recordCashCount(
  orgId: string,
  accountId: string,
  input: CashCountInput,
  countedByName: string,
): Promise<ReconciliationSessionDTO> {
  const oid = new Types.ObjectId(orgId);
  const account = await BankAccount.findOne({ _id: new Types.ObjectId(accountId), organizationId: oid });
  if (!account) throw new AppError("NOT_FOUND", "Bank account not found");

  const countedOn = new Date(input.countedOn);
  if (Number.isNaN(countedOn.getTime())) {
    throw new AppError("VALIDATION_ERROR", "That is not a date");
  }

  const bookBalanceMinor = (account.currentBalanceMinor as number) ?? 0;
  const { differenceMinor, adjustmentMinor, verdict } = compareCashCount(
    input.countedMinor,
    bookBalanceMinor,
  );

  const session = await ReconciliationSession.create({
    organizationId: oid,
    accountId: account._id,
    accountName: account.accountName,
    currency: account.currency,
    statementDate: countedOn,
    statementBalanceMinor: input.countedMinor,
    openingBookBalanceMinor:
      (account.lastReconciledStatementBalanceMinor as number | undefined) ??
      (account.openingBalanceMinor as number) ??
      0,
    closingBookBalanceMinor: bookBalanceMinor,
    differenceMinor,
    notes: input.notes ?? "",
    status: "completed",
    completedAt: new Date(),
    completedByName: countedByName,
  });

  // Named so it is obvious in the book why the balance moved, and over or short
  // so nobody has to work out which from the sign.
  if (adjustmentMinor !== 0) {
    const adjustment = await addTransaction(orgId, accountId, {
      date: input.countedOn,
      description: `Cash count adjustment (${verdict})`,
      reference: "",
      amountMinor: adjustmentMinor,
      notes: `Counted ${(input.countedMinor / 100).toFixed(2)} against a book balance of ${(bookBalanceMinor / 100).toFixed(2)}.`,
    });
    // So undoing the count can take it back out again.
    await ReconciliationSession.updateOne(
      { _id: session._id },
      { $set: { adjustmentTransactionId: adjustment.id } },
    );
    session.set("adjustmentTransactionId", adjustment.id);
  }

  await BankTransaction.updateMany(
    { organizationId: oid, accountId: account._id, date: { $lte: countedOn }, isReconciled: { $ne: true } },
    { $set: { isReconciled: true, reconciledSessionId: String(session._id) } },
  );

  await BankAccount.updateOne(
    { _id: account._id, organizationId: oid },
    { $set: { lastReconciledAt: new Date(), lastReconciledStatementBalanceMinor: input.countedMinor } },
  );

  return sessionToDTO(session);
}

/**
 * Undo a cash count.
 *
 * Counting locks every entry up to its date, which is right — they were signed
 * off against a figure somebody counted. But it also means a mistyped entry
 * becomes uncorrectable, and the only honest way back is to withdraw the count
 * that signed it off rather than to quietly edit underneath one.
 *
 * Takes back the adjustment it posted, releases the entries it locked, and
 * hands the account back to whichever count came before it — so the next count
 * measures from where the last real one left off, not from nothing.
 */
export async function deleteCashCount(
  orgId: string,
  accountId: string,
  sessionId: string,
): Promise<void> {
  const oid = new Types.ObjectId(orgId);
  const session = await ReconciliationSession.findOne({
    _id: new Types.ObjectId(sessionId),
    accountId: new Types.ObjectId(accountId),
    organizationId: oid,
  });
  if (!session) throw new AppError("NOT_FOUND", "Count not found");

  const adjustmentId = (session as unknown as { adjustmentTransactionId?: string })
    .adjustmentTransactionId;
  if (adjustmentId) {
    await BankTransaction.deleteOne({ _id: new Types.ObjectId(adjustmentId), organizationId: oid });
  }

  await BankTransaction.updateMany(
    { organizationId: oid, accountId: session.accountId, reconciledSessionId: sessionId },
    { $unset: { isReconciled: "", reconciledSessionId: "" } },
  );

  await ReconciliationSession.deleteOne({ _id: session._id });

  // Whatever count now stands as the most recent one for this account.
  const previous = await ReconciliationSession.findOne({
    organizationId: oid,
    accountId: session.accountId,
    status: "completed",
  }).sort({ statementDate: -1, completedAt: -1 });

  await BankAccount.updateOne(
    { _id: session.accountId, organizationId: oid },
    previous
      ? {
          $set: {
            lastReconciledAt: previous.completedAt ?? new Date(),
            lastReconciledStatementBalanceMinor: previous.statementBalanceMinor,
          },
        }
      : { $unset: { lastReconciledAt: "", lastReconciledStatementBalanceMinor: "" } },
  );

  // The adjustment may have gone, so every balance after it has moved.
  await recalculateRunningBalances(orgId, session.accountId as unknown as Types.ObjectId);
}

/**
 * Correct a count that was already recorded.
 *
 * Withdrawn and taken again rather than edited in place. A count owns an
 * adjustment entry, a set of locked rows and the account's last-counted mark;
 * editing the figure alone would leave those three disagreeing with it, and
 * with each other.
 */
export async function updateCashCount(
  orgId: string,
  accountId: string,
  sessionId: string,
  input: CashCountInput,
  countedByName: string,
): Promise<ReconciliationSessionDTO> {
  await deleteCashCount(orgId, accountId, sessionId);
  return recordCashCount(orgId, accountId, input, countedByName);
}

export async function getReconciliation(
  orgId: string,
  sessionId: string,
): Promise<ReconciliationSessionDTO> {
  const doc = await ReconciliationSession.findOne({
    _id: new Types.ObjectId(sessionId),
    organizationId: new Types.ObjectId(orgId),
  });
  if (!doc) throw new AppError("NOT_FOUND", "Reconciliation session not found");
  return sessionToDTO(doc);
}

export async function listReconciliations(
  orgId: string,
  accountId: string,
  query: { page: number; pageSize: number },
): Promise<Paginated<ReconciliationSessionDTO>> {
  const { page, pageSize } = query;
  const filter = {
    organizationId: new Types.ObjectId(orgId),
    accountId: new Types.ObjectId(accountId),
  };
  const [docs, total] = await Promise.all([
    ReconciliationSession.find(filter)
      .sort({ statementDate: -1 })
      .skip(skipFor(page, pageSize))
      .limit(pageSize)
      .lean(),
    ReconciliationSession.countDocuments(filter),
  ]);
  return {
    data: (docs as unknown as ReconciliationSessionDoc[]).map(sessionToDTO),
    meta: pageMeta(total, page, pageSize),
  };
}
