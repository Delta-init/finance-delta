import { z } from "zod";

// ── Bank Account ──────────────────────────────────────────────────────────────

export const bankAccountTypeSchema = z.enum(["checking", "savings", "petty_cash", "internal"]);
export type BankAccountType = z.infer<typeof bankAccountTypeSchema>;

export const BANK_ACCOUNT_TYPE_LABELS: Record<BankAccountType, string> = {
  checking: "Checking",
  savings: "Savings",
  petty_cash: "Petty Cash",
  internal: "Internal Fund",
};

export const createBankAccountSchema = z.object({
  accountName: z.string().min(1, "Account name is required"),
  accountNumber: z.string().optional().default(""),
  bankName: z.string().optional().default(""),
  accountType: bankAccountTypeSchema,
  currency: z.string().min(3).max(3),
  openingBalanceMinor: z.number().default(0),
  openingDate: z.string().min(1, "Opening date is required"),
  notes: z.string().optional().default(""),
});
export type CreateBankAccountInput = z.infer<typeof createBankAccountSchema>;

export const updateBankAccountSchema = createBankAccountSchema.partial();
export type UpdateBankAccountInput = z.infer<typeof updateBankAccountSchema>;

export const bankAccountSchema = z.object({
  id: z.string(),
  accountName: z.string(),
  accountNumber: z.string(),
  bankName: z.string(),
  accountType: bankAccountTypeSchema,
  currency: z.string(),
  currentBalanceMinor: z.number(),
  openingBalanceMinor: z.number(),
  openingDate: z.string(),
  isActive: z.boolean(),
  lastReconciledAt: z.string().optional(),
  lastReconciledStatementBalanceMinor: z.number().optional(),
  notes: z.string(),
  createdAt: z.string(),
});
export type BankAccount = z.infer<typeof bankAccountSchema>;

// ── Bank Transaction ──────────────────────────────────────────────────────────

export const bankTransactionStatusSchema = z.enum(["unmatched", "matched", "excluded", "duplicate"]);
export type BankTransactionStatus = z.infer<typeof bankTransactionStatusSchema>;

export const bankTransactionMatchSchema = z.object({
  type: z.enum(["invoice", "bill", "expense"]),
  referenceId: z.string(),
  referenceNumber: z.string(),
  amountMinor: z.number(),
});
export type BankTransactionMatch = z.infer<typeof bankTransactionMatchSchema>;

export const createBankTransactionSchema = z.object({
  date: z.string().min(1, "Date is required"),
  description: z.string().min(1, "Description is required"),
  reference: z.string().optional().default(""),
  amountMinor: z.number(),
  notes: z.string().optional().default(""),
});
export type CreateBankTransactionInput = z.infer<typeof createBankTransactionSchema>;

/**
 * Correcting an entry after the fact.
 *
 * Only what a person actually typed. `type` follows the sign of the amount,
 * and the running balance is derived from every transaction on the account in
 * date order — neither is somebody's to set, and accepting them here would let
 * a correction contradict the ledger it sits in.
 */
export const updateBankTransactionSchema = z
  .object({
    date: z.string().min(1),
    description: z.string().min(1, "Description is required"),
    reference: z.string(),
    amountMinor: z.number(),
    notes: z.string(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to change");
export type UpdateBankTransactionInput = z.infer<typeof updateBankTransactionSchema>;

export const bulkImportTransactionsSchema = z.object({
  transactions: z.array(createBankTransactionSchema).min(1, "At least one transaction required"),
  importBatchId: z.string().optional(),
});
export type BulkImportTransactionsInput = z.infer<typeof bulkImportTransactionsSchema>;

export const matchTransactionSchema = bankTransactionMatchSchema;
export type MatchTransactionInput = z.infer<typeof matchTransactionSchema>;

export const bankTransactionSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  accountName: z.string(),
  currency: z.string(),
  date: z.string(),
  description: z.string(),
  reference: z.string(),
  amountMinor: z.number(),
  type: z.enum(["credit", "debit"]),
  runningBalanceMinor: z.number(),
  source: z.enum(["manual", "import"]),
  importBatchId: z.string().optional(),
  status: bankTransactionStatusSchema,
  matches: z.array(bankTransactionMatchSchema),
  isReconciled: z.boolean(),
  reconciledSessionId: z.string().optional(),
  notes: z.string(),
  createdAt: z.string(),
});
export type BankTransaction = z.infer<typeof bankTransactionSchema>;

// ── Reconciliation ────────────────────────────────────────────────────────────

export const startReconciliationSchema = z.object({
  statementDate: z.string().min(1, "Statement date is required"),
  statementBalanceMinor: z.number(),
  notes: z.string().optional().default(""),
});
export type StartReconciliationInput = z.infer<typeof startReconciliationSchema>;

export const updateReconciliationSchema = z.object({
  reconciledTransactionIds: z.array(z.string()),
  notes: z.string().optional(),
});
export type UpdateReconciliationInput = z.infer<typeof updateReconciliationSchema>;

export const reconciliationSessionSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  accountName: z.string(),
  currency: z.string(),
  statementDate: z.string(),
  statementBalanceMinor: z.number(),
  openingBookBalanceMinor: z.number(),
  closingBookBalanceMinor: z.number(),
  differenceMinor: z.number(),
  status: z.enum(["open", "completed"]),
  reconciledTransactionIds: z.array(z.string()),
  completedAt: z.string().optional(),
  completedByName: z.string().optional(),
  notes: z.string(),
  createdAt: z.string(),
});
export type ReconciliationSession = z.infer<typeof reconciliationSessionSchema>;
