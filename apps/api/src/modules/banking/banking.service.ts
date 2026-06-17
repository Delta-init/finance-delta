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
  BulkImportTransactionsInput,
  MatchTransactionInput,
  StartReconciliationInput,
  UpdateReconciliationInput,
} from "@delta/shared";
import { AppError } from "../../lib/http";
import { buildSort, pageMeta, searchOr, skipFor } from "../../lib/paginate";
import { BankAccount, type BankAccountDoc } from "./bank-account.model";
import { BankTransaction, type BankTransactionDoc } from "./bank-transaction.model";
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
    reconciledTransactionIds: (doc.reconciledTransactionIds as Types.ObjectId[]).map((id) =>
      id.toString(),
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

  const prevBalance = (account.currentBalanceMinor as number) ?? 0;
  const newBalance = prevBalance + input.amountMinor;
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
    runningBalanceMinor: newBalance,
    source,
    importBatchId: importBatchId ?? undefined,
    notes: input.notes ?? "",
  });

  await BankAccount.updateOne(
    { _id: account._id },
    { $set: { currentBalanceMinor: newBalance } },
  );

  return txToDTO(doc);
}

export async function bulkImportTransactions(
  orgId: string,
  accountId: string,
  input: BulkImportTransactionsInput,
): Promise<{ count: number; transactions: BankTransactionDTO[] }> {
  const account = await BankAccount.findOne({
    _id: new Types.ObjectId(accountId),
    organizationId: new Types.ObjectId(orgId),
  });
  if (!account) throw new AppError("NOT_FOUND", "Bank account not found");

  const sorted = [...input.transactions].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );

  let runningBalance = (account.currentBalanceMinor as number) ?? 0;
  const batchId = input.importBatchId ?? new Types.ObjectId().toString();

  const docs = sorted.map((tx) => {
    runningBalance = runningBalance + tx.amountMinor;
    return {
      organizationId: new Types.ObjectId(orgId),
      accountId: new Types.ObjectId(accountId),
      accountName: account.accountName as string,
      currency: account.currency as string,
      date: new Date(tx.date),
      description: tx.description,
      reference: tx.reference ?? "",
      amountMinor: tx.amountMinor,
      type: tx.amountMinor >= 0 ? ("credit" as const) : ("debit" as const),
      runningBalanceMinor: runningBalance,
      source: "import" as const,
      importBatchId: batchId,
      notes: tx.notes ?? "",
    };
  });

  const inserted = await BankTransaction.insertMany(docs);
  await BankAccount.updateOne(
    { _id: account._id },
    { $set: { currentBalanceMinor: runningBalance } },
  );

  return {
    count: inserted.length,
    transactions: (inserted as unknown as BankTransactionDoc[]).map(txToDTO),
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

  const reconciledIds = (session.reconciledTransactionIds as Types.ObjectId[]);

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
