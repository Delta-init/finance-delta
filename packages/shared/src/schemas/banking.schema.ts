import { z } from "zod";
import { lateReasonSchema, recordLateEntrySchema } from "./late-entry.schema";

// ── Bank Account ──────────────────────────────────────────────────────────────

export const bankAccountTypeSchema = z.enum(["current", "savings", "petty_cash", "internal", "psp"]);
export type BankAccountType = z.infer<typeof bankAccountTypeSchema>;

export const BANK_ACCOUNT_TYPE_LABELS: Record<BankAccountType, string> = {
  current: "Current",
  savings: "Savings",
  petty_cash: "Petty Cash",
  internal: "Internal Fund",
  psp: "PSP",
};

/**
 * A payment service provider's account (the user, 2026-11-06): Tabby, Tamara, Billexpro, Easebuzz, a card acquirer.
 * Clients' payments land in it whole; the provider pays them on to a bank account later, less its fee — a settlement
 * (psp-settlement). What it charges — a percentage, a fixed amount a payment, VAT on the fee — is what each payment
 * is expected to cost; what actually arrived decides the fee booked.
 */
export const pspSettingsSchema = z.object({
  provider: z.string().trim().max(60).default(""),
  /** Of each payment, e.g. 5.5. */
  feePct: z.number().min(0).max(100).default(0),
  /** A payment, in the account's currency. */
  fixedFeeMinor: z.number().int().min(0).default(0),
  /** On the fee, e.g. 5. */
  feeVatPct: z.number().min(0).max(100).default(0),
  /** The bank account it pays out to. */
  settlementAccountId: z.string().min(1, "Choose the account it settles into"),
  /** How many days after a payment its money is expected there. */
  settlementDays: z.number().int().min(0).max(120).default(7),
  /** Payments dated before this count as settled already — the day it became a PSP account, unless said. */
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export type PspSettings = z.infer<typeof pspSettingsSchema>;

/** What one payment is expected to cost: the percentage and the fixed fee, and VAT on both. */
export function expectedPspFeeMinor(amountMinor: number, s: Pick<PspSettings, "feePct" | "fixedFeeMinor" | "feeVatPct">): number {
  if (!(amountMinor > 0)) return 0;
  const fee = (amountMinor * (s.feePct ?? 0)) / 100 + (s.fixedFeeMinor ?? 0);
  return Math.min(amountMinor, Math.round(fee * (1 + (s.feeVatPct ?? 0) / 100)));
}

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
  /** A PSP account's (accountType "psp"). */
  psp: pspSettingsSchema.nullable().optional(),
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
  /** A PSP account's settings, its settlement account named. */
  psp: pspSettingsSchema.extend({ settlementAccountName: z.string(), startDate: z.string() }).nullable().optional(),
  createdAt: z.string(),
});
export type BankAccount = z.infer<typeof bankAccountSchema>;

// ── PSP settlements (2026-11-06) ─────────────────────────────────────────────

export const createPspSettlementSchema = z.object({
  /** The PSP account's money-in lines being settled. */
  lineIds: z.array(z.string().min(1)).min(1, "Pick the payments being settled").max(2000),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date is required"),
  /** What arrived in the bank account. */
  receivedMinor: z.number().int().positive("What arrived must be more than 0"),
  reference: z.string().max(100).optional().default(""),
  notes: z.string().max(1000).optional().default(""),
});
export type CreatePspSettlementInput = z.infer<typeof createPspSettlementSchema>;

/** A money-in line in a PSP account not settled yet. */
export interface PspUnsettledLine {
  id: string;
  date: string;
  description: string;
  reference: string;
  amountMinor: number;
  /** The invoice it is a payment on, where it is one. */
  invoice: { id: string; number: string } | null;
  expectedFeeMinor: number;
  /** When the provider should have paid it out. */
  expectedOn: string;
  late: boolean;
}

export interface PspSettlementDTO {
  id: string;
  number: string;
  date: string;
  pspAccountId: string;
  pspAccountName: string;
  bankAccountId: string;
  bankAccountName: string;
  currency: string;
  lineCount: number;
  grossMinor: number;
  receivedMinor: number;
  feeMinor: number;
  expectedFeeMinor: number;
  expense: { id: string; number: string } | null;
  reference: string;
  notes: string;
  createdByName: string;
  createdAt: string;
}

export interface PspSummary {
  unsettledMinor: number;
  unsettledCount: number;
  expectedFeeMinor: number;
  lateCount: number;
  lateMinor: number;
}

/** One PSP account and what it holds unsettled — the dashboard's card (2026-11-06). */
export interface PspAccountSummary extends PspSummary {
  accountId: string;
  accountName: string;
  provider: string;
  currency: string;
  settlementAccountName: string;
  /** The oldest payment waiting, if any. */
  oldestDate: string | null;
}

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

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "A date is YYYY-MM-DD");
export const startReconciliationSchema = z.object({
  statementDate: z.string().min(1, "Statement date is required"),
  statementBalanceMinor: z.number(),
  /* The period this statement covers (the user, 2026-10-23: "reconcile by this month, this week, today") — only its
     unreconciled lines are listed — and the statement's balance at its start, which the ticked lines are added to.
     Without them a session works as before (every unreconciled line, from the last reconciled balance). */
  periodFrom: isoDay.optional(),
  periodTo: isoDay.optional(),
  openingBalanceMinor: z.number().int().optional(),
  notes: z.string().optional().default(""),
}).refine((v) => !v.periodFrom || !v.periodTo || v.periodFrom <= v.periodTo, { message: "The period ends before it starts", path: ["periodTo"] })
  .refine((v) => !!v.periodFrom === !!v.periodTo, { message: "Give the period's first and last day", path: ["periodFrom"] });
export type StartReconciliationInput = z.infer<typeof startReconciliationSchema>;

export const updateReconciliationSchema = z.object({
  reconciledTransactionIds: z.array(z.string()),
  /* The day the statement shows each ticked line, where it isn't the line's own date (2026-10-23): line id →
     YYYY-MM-DD. Kept with the session; written to the lines (and their expenses) when it is completed. */
  statementDates: z.record(z.string(), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "A statement date is YYYY-MM-DD")).optional(),
  notes: z.string().optional(),
});
export type UpdateReconciliationInput = z.infer<typeof updateReconciliationSchema>;

/* Correcting a reconciliation (the user, 2026-10-23: "edit and delete for the reconciliations"). An open one: its
   period, statement date, opening and closing balances and notes, checked as when it was started. A completed one:
   its notes only — its figures are what its ticked lines were signed off against; reopen it to change them. */
export const editReconciliationSchema = z.object({
  periodFrom: isoDay.optional(),
  periodTo: isoDay.optional(),
  statementDate: isoDay.optional(),
  statementBalanceMinor: z.number().int().optional(),
  openingBalanceMinor: z.number().int().optional(),
  notes: z.string().optional(),
}).refine((v) => !v.periodFrom || !v.periodTo || v.periodFrom <= v.periodTo, { message: "The period ends before it starts", path: ["periodTo"] })
  .refine((v) => !!v.periodFrom === !!v.periodTo, { message: "Give the period's first and last day", path: ["periodFrom"] });
export type EditReconciliationInput = z.infer<typeof editReconciliationSchema>;

export const reconciliationSessionSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  accountName: z.string(),
  currency: z.string(),
  statementDate: z.string(),
  statementBalanceMinor: z.number(),
  /** The period it covers (2026-10-23); absent on a session started before periods. */
  periodFrom: z.string().optional(),
  periodTo: z.string().optional(),
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
  /** The account's latest completed reconciliation — the only one that can be reopened or deleted (2026-10-23). */
  undoable: z.boolean().optional(),
  /** The bank statement uploaded to check it against (2026-11-07), and the last check. */
  statementFile: z.object({ name: z.string(), url: z.string() }).optional(),
  statementCheck: z.any().optional(),
});
export type ReconciliationSession = z.infer<typeof reconciliationSessionSchema> & { statementCheck?: StatementCheck };

/* ── A bank statement uploaded to reconcile against (the user, 2026-11-07: "upload the statement on the form; we
   check it ourselves — if it is right it reconciles, otherwise how much and which transaction is not correct") ── */

/** One statement line, read from the file in the browser: money in positive, money out negative. */
export const statementLineInputSchema = z.object({
  date: isoDay,
  description: z.string().max(300).optional().default(""),
  reference: z.string().max(120).optional().default(""),
  amountMinor: z.number().int().refine((v) => v !== 0, "A line of nothing"),
  balanceMinor: z.number().int().nullable().optional(),
});
export type StatementLineInput = z.infer<typeof statementLineInputSchema>;

/** Check the session against these lines — or, left out, against the statement uploaded last ("Check again"). */
export const checkStatementSchema = z.object({
  lines: z.array(statementLineInputSchema).min(1, "The statement has no lines").max(5000).optional(),
  fileName: z.string().max(200).optional().default(""),
});
export type CheckStatementInput = z.infer<typeof checkStatementSchema>;

/** A statement line not in the books, put in them: money out as an expense (its category), money in as an entry. */
export const addStatementLineSchema = z.object({
  category: z.string().max(60).optional(),
  subcategory: z.string().max(60).optional(),
});
export type AddStatementLineInput = z.infer<typeof addStatementLineSchema>;

export interface StatementCheckBookLine { id: string; date: string; description: string; reference: string; amountMinor: number }

export interface StatementCheckLine {
  index: number;
  date: string;
  description: string;
  reference: string;
  amountMinor: number;
  balanceMinor: number | null;
  status: "matched" | "amount_differs" | "not_in_books";
  /** The book line(s) it is paired with: one, or a line and the bank charge recorded for its difference. */
  bookLines: StatementCheckBookLine[];
  /** Statement minus books, where the amount differs. */
  differenceMinor?: number;
}

export interface StatementCheck {
  checkedAt: string;
  fileName: string;
  /** How many days apart a statement line and its book line may be. */
  windowDays: number;
  lines: StatementCheckLine[];
  /** Lines in the books, in the period, the statement doesn't have. */
  notOnStatement: StatementCheckBookLine[];
  summary: {
    statementLines: number;
    matched: number;
    amountDiffers: number;
    notInBooks: number;
    notOnStatement: number;
    /** What the statement brings in and takes out. */
    inMinor: number;
    outMinor: number;
    /** Adding up what doesn't agree: the differences, what is missing from the books, less what the statement lacks. */
    unexplainedMinor: number;
    /** The statement file's own closing balance, when it has a balance column, and whether it is the one typed in. */
    fileClosingMinor: number | null;
    closingAgrees: boolean | null;
  };
  /** Every statement line matched, nothing left over, the difference nil: it can be reconciled in one go. */
  allMatch: boolean;
}

/** The balance a period starts from: the last reconciliation's closing balance when it ends the day before, else the book's. */
export interface ReconciliationOpening {
  periodFrom: string;
  openingBalanceMinor: number;
  source: "last_reconciliation" | "book";
  /** The last completed reconciliation's last day — a new period must start after it. */
  reconciledTo: string | null;
}
