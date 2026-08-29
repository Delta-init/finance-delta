import { Types } from "mongoose";
import type {
  CreateBankAccountInput,
  UpdateBankAccountInput,
  BankAccount as BankAccountDTO,
  BankTransaction as BankTransactionDTO,
  ReconciliationSession as ReconciliationSessionDTO,
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
} from "@delta/shared";
import { fingerprint } from "@delta/shared";
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
    notes: (doc.notes as string) ?? "",
    createdAt: (doc as unknown as { createdAt: Date }).createdAt.toISOString(),
  };
}

function sessionToDTO(doc: ReconciliationSessionDoc): ReconciliationSessionDTO {
  return {
    id: doc._id.toString(),
    accountId: doc.accountId.toString(),
    accountName: doc.accountName,
    currency: doc.currency,
    statementDate: dateOnly(doc.statementDate as unknown as Date),
    statementBalanceMinor: doc.statementBalanceMinor,
    openingBookBalanceMinor: doc.openingBookBalanceMinor,
    closingBookBalanceMinor: doc.closingBookBalanceMinor,
    differenceMinor: doc.differenceMinor,
    status: doc.status as ReconciliationSessionDTO["status"],
    reconciledTransactionIds: (doc.reconciledTransactionIds as unknown as Types.ObjectId[]).map(
      (id) => id.toString(),
    ),
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
async function assertEditable(orgId: string, accountId: string, txId: string) {
  const tx = await BankTransaction.findOne({
    _id: new Types.ObjectId(txId),
    accountId: new Types.ObjectId(accountId),
    organizationId: new Types.ObjectId(orgId),
  });
  if (!tx) throw new AppError("NOT_FOUND", "Transaction not found");

  if (tx.isReconciled) {
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
): Promise<BankTransactionDTO> {
  const tx = await assertEditable(orgId, accountId, txId);

  if (input.date !== undefined) tx.date = new Date(input.date);
  if (input.description !== undefined) tx.description = input.description;
  if (input.reference !== undefined) tx.reference = input.reference;
  if (input.notes !== undefined) tx.notes = input.notes;
  if (input.amountMinor !== undefined) {
    tx.amountMinor = input.amountMinor;
    // Direction follows the sign, exactly as it does on the way in.
    tx.type = input.amountMinor >= 0 ? "credit" : "debit";
  }
  await tx.save();

  await recalculateRunningBalances(orgId, tx.accountId as Types.ObjectId);

  const fresh = await BankTransaction.findById(tx._id);
  return txToDTO(fresh!);
}

/** Remove an entry that should never have been there. */
export async function deleteTransaction(
  orgId: string,
  accountId: string,
  txId: string,
): Promise<void> {
  const tx = await assertEditable(orgId, accountId, txId);
  const account = tx.accountId as Types.ObjectId;
  await BankTransaction.deleteOne({ _id: tx._id });
  await recalculateRunningBalances(orgId, account);
}

export async function addTransaction(
  orgId: string,
  accountId: string,
  input: CreateBankTransactionInput,
  source: "manual" | "import" = "manual",
  importBatchId?: string,
): Promise<BankTransactionDTO> {
  const account = await BankAccount.findOne({
    _id: new Types.ObjectId(accountId),
    organizationId: new Types.ObjectId(orgId),
  });
  if (!account) throw new AppError("NOT_FOUND", "Bank account not found");

  const txType = input.amountMinor >= 0 ? "credit" : "debit";

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
  });

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
  const { page, pageSize, sort, dir, q, status, dateFrom, dateTo, isReconciled, source } = query;
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
  const orClauses = searchOr(q, ["description", "reference"]);
  if (orClauses) Object.assign(filter, { $or: orClauses });

  const [docs, total] = await Promise.all([
    BankTransaction.find(filter)
      .sort(buildSort(TX_SORT, sort, dir, { date: -1 }))
      .skip(skipFor(page, pageSize))
      .limit(pageSize)
      .lean(),
    BankTransaction.countDocuments(filter),
  ]);
  return {
    data: (docs as unknown as BankTransactionDoc[]).map(txToDTO),
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

  const openingBalance = (account.lastReconciledStatementBalanceMinor as number | undefined) ??
    (account.openingBalanceMinor as number) ?? 0;

  const closingBookBalance = (account.currentBalanceMinor as number) ?? 0;
  const differenceMinor = input.statementBalanceMinor - closingBookBalance;

  const doc = await ReconciliationSession.create({
    organizationId: new Types.ObjectId(orgId),
    accountId: new Types.ObjectId(accountId),
    accountName: account.accountName,
    currency: account.currency,
    statementDate: new Date(input.statementDate),
    statementBalanceMinor: input.statementBalanceMinor,
    openingBookBalanceMinor: openingBalance,
    closingBookBalanceMinor: closingBookBalance,
    differenceMinor,
    notes: input.notes ?? "",
  });
  return sessionToDTO(doc);
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

  const updated = await ReconciliationSession.findByIdAndUpdate(
    sessionId,
    {
      $set: {
        reconciledTransactionIds: reconciledIds,
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
