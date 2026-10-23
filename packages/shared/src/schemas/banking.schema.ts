import { z } from "zod";
import { lateReasonSchema, recordLateEntrySchema } from "./late-entry.schema";

// ── Bank Account ──────────────────────────────────────────────────────────────

export const bankAccountTypeSchema = z.enum(["current", "savings", "petty_cash", "internal"]);
export type BankAccountType = z.infer<typeof bankAccountTypeSchema>;

export const BANK_ACCOUNT_TYPE_LABELS: Record<BankAccountType, string> = {
  current: "Current",
  savings: "Savings",
  petty_cash: "Petty Cash",
  internal: "Internal Fund",
};

export const createBankAccountSchema = z.object({
  accountName: z.string().min(1, "Account name is required"),
  accountNumber: z.string().optional().default(""),
  bankName: z.string().optional().default(""),
  // Printed on invoices so a client can pay. Which of these applies depends on
  // where the account is held, so all four are optional.
  branch: z.string().max(120).optional().default(""),
  ifsc: z.string().max(20).optional().default(""),
  swift: z.string().max(20).optional().default(""),
  iban: z.string().max(40).optional().default(""),
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
  branch: z.string().default(""),
  ifsc: z.string().default(""),
  swift: z.string().default(""),
  iban: z.string().default(""),
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
  /** Typed in with an old date: why (late entries, 2026-10-21). */
  lateReason: lateReasonSchema,
  /**
   * What money paid out was for (the user, 2026-10-22: "in petty add category, and category and subcategory filter"):
   * an expense category's slug and one of its subcategories. Only on money going out; "" for none.
   */
  category: z.string().max(60).optional(),
  subcategory: z.string().max(60).optional(),
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
    lateReason: z.string().trim().max(500),
    /** "" clears it. */
    category: z.string().max(60),
    subcategory: z.string().max(60),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to change");
export type UpdateBankTransactionInput = z.infer<typeof updateBankTransactionSchema>;

/**
 * Money moved between two of the organization's own accounts (the user, 2026-10-22: "a new item in petty cash, an
 * internal transfer") — a tin topped up from the bank, the tin's cash banked, one bank to another. One transfer is
 * two linked lines, out of one account and into the other, on the same day; neither income nor an expense. Between
 * accounts in different currencies both figures are given: what left, and what arrived.
 */
export const createTransferSchema = z.object({
  fromAccountId: z.string().min(1, "Choose the account it comes from"),
  toAccountId: z.string().min(1, "Choose the account it goes to"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date is required"),
  /** What left the first account, in its currency. */
  amountMinor: z.number().int().positive("Amount must be more than 0"),
  /** What arrived in the second, in its currency — only between currencies (else the same as the amount). */
  receivedMinor: z.number().int().positive().optional(),
  reference: z.string().max(100).optional().default(""),
  notes: z.string().max(1000).optional().default(""),
  lateReason: lateReasonSchema,
});
export type CreateTransferInput = z.infer<typeof createTransferSchema>;

/** Correcting a transfer: both of its lines move together. Which accounts it is between stays — delete it and redo. */
export const updateTransferSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    amountMinor: z.number().int().positive("Amount must be more than 0"),
    receivedMinor: z.number().int().positive(),
    reference: z.string().max(100),
    notes: z.string().max(1000),
    lateReason: z.string().trim().max(500),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to change");
export type UpdateTransferInput = z.infer<typeof updateTransferSchema>;

/** A line's side of a transfer: which way, and the other account and what moved there. */
export const bankTransferLinkSchema = z.object({
  id: z.string(),
  direction: z.enum(["out", "in"]),
  otherAccountId: z.string(),
  otherAccountName: z.string(),
  otherTransactionId: z.string(),
  otherAmountMinor: z.number(),
  otherCurrency: z.string(),
});
export type BankTransferLink = z.infer<typeof bankTransferLinkSchema>;

/**
 * One line of a bank statement being imported.
 *
 * Stricter than a hand-typed transaction on purpose. The wizard parses dates
 * and amounts before sending them, so anything arriving here has already been
 * through that — and if it has not, it came from somewhere that skipped the
 * parsing, which is exactly the case worth refusing.
 */
export const importedTransactionSchema = createBankTransactionSchema.extend({
  // `new Date("15/01/2026")` is Invalid Date and `new Date("01/02/2026")` is
  // the wrong month in half the world. Only an unambiguous calendar day is
  // accepted; working out which layout a bank used is the wizard's job.
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
    .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), "Not a real date"),
  // Minor units are indivisible. A fraction here means somebody multiplied by
  // 100 in floating point and kept the error.
  amountMinor: z.number().int("Amount must be in whole minor units"),
  /**
   * The bank's own reference for the line, where the statement has one.
   *
   * When present it identifies the transaction outright, so a re-import is
   * recognised even if the bank has since reworded the description.
   */
  externalId: z.string().trim().max(120).optional(),
});
export type ImportedTransactionInput = z.infer<typeof importedTransactionSchema>;

export const bulkImportTransactionsSchema = z.object({
  transactions: z.array(importedTransactionSchema).min(1, "At least one transaction required"),
  importBatchId: z.string().optional(),
  /**
   * What to do with a line already on the account.
   *
   * Defaults to leaving it out: re-importing an overlapping statement is the
   * ordinary case — most people export a whole month every month — and silently
   * doubling every shared line is the failure people notice last.
   */
  onDuplicate: z.enum(["skip", "import"]).optional().default("skip"),
});
export type BulkImportTransactionsInput = z.infer<typeof bulkImportTransactionsSchema>;

/** Asks which lines are already on the account, without writing anything. */
export const previewImportSchema = z.object({
  transactions: z.array(importedTransactionSchema).min(1, "At least one transaction required"),
});
export type PreviewImportInput = z.infer<typeof previewImportSchema>;

/**
 * Counting a tin.
 *
 * The same question a bank reconciliation asks — does the book agree with
 * reality — with the counted cash standing in for a statement balance. The
 * difference is posted as an entry of its own, or the count records a
 * disagreement and then leaves it in place.
 */
export const cashCountSchema = z.object({
  countedOn: z.string().min(1, "Date is required"),
  countedMinor: z.number().int().min(0),
  notes: z.string().max(300).optional().default(""),
});
export type CashCountInput = z.infer<typeof cashCountSchema>;

/** Correcting a count that was already recorded. Applied by undoing and redoing it. */
export const updateCashCountSchema = cashCountSchema;
export type UpdateCashCountInput = z.infer<typeof updateCashCountSchema>;

export const matchTransactionSchema = bankTransactionMatchSchema;
export type MatchTransactionInput = z.infer<typeof matchTransactionSchema>;

export const bankTransactionAttachmentSchema = z.object({
  name: z.string(),
  url: z.string(),
  key: z.string().optional(),
  size: z.number().optional(),
  mimeType: z.string().optional(),
  uploadedAt: z.string().optional(),
});
export type BankTransactionAttachment = z.infer<typeof bankTransactionAttachmentSchema>;

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
  /** The bank's own reference, on rows imported from a statement that had one. */
  externalId: z.string().optional(),
  status: bankTransactionStatusSchema,
  matches: z.array(bankTransactionMatchSchema),
  isReconciled: z.boolean(),
  reconciledSessionId: z.string().optional(),
  /** The day the bank statement shows it — entered when it is reconciled (2026-10-23). */
  statementDate: z.string().optional(),
  attachments: z.array(bankTransactionAttachmentSchema).default([]),
  notes: z.string(),
  createdAt: z.string(),
  /** Typed in with an old date: waiting for a manager, or what one decided. */
  lateEntry: recordLateEntrySchema.optional(),
  /** One side of a transfer between the organization's own accounts (2026-10-22). */
  transfer: bankTransferLinkSchema.optional(),
  /**
   * What it was for (2026-10-22): the line's own category, or — on the line an expense paid from this account
   * made — that expense's (`fromExpense`).
   */
  category: z.object({
    slug: z.string(),
    name: z.string(),
    subcategory: z.string().optional(),
    subcategoryName: z.string().optional(),
    fromExpense: z.boolean(),
  }).optional(),
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
  /* The day the statement shows each ticked line, where it isn't the line's own date (2026-10-23): line id →
     YYYY-MM-DD. Kept with the session; written to the lines (and their expenses) when it is completed. */
  statementDates: z.record(z.string(), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "A statement date is YYYY-MM-DD")).optional(),
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
  /** Line id → the statement's date for it, where it was changed from the line's own (2026-10-23). */
  statementDates: z.record(z.string(), z.string()).default({}),
  completedAt: z.string().optional(),
  completedByName: z.string().optional(),
  /** Set when the count posted an entry to bring the book to the counted figure. */
  adjustmentTransactionId: z.string().optional(),
  notes: z.string(),
  createdAt: z.string(),
});
export type ReconciliationSession = z.infer<typeof reconciliationSessionSchema>;
