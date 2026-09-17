import { z } from "zod";
import { departmentRefSchema } from "./department.schema";

export const expenseCategorySchema = z.enum([
  "salaries_wages",
  "commissions",
  "rent",
  "utilities",
  "travel",
  "marketing",
  "other",
]);
export type ExpenseCategory = z.infer<typeof expenseCategorySchema>;

export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  salaries_wages: "Salaries & Wages",
  commissions: "Commissions",
  rent: "Rent",
  utilities: "Utilities",
  travel: "Travel",
  marketing: "Marketing",
  other: "Other",
};

export const expenseStatusSchema = z.enum([
  "draft",
  "submitted",
  "approved",
  "rejected",
  "voided",
]);
export type ExpenseStatus = z.infer<typeof expenseStatusSchema>;

/**
 * Whether the money has actually gone out, which the approval status does not
 * say.
 *
 * `status` is an approval workflow — drafted, submitted, approved, rejected —
 * and an approved claim is a promise to pay, not a payment. These two ran
 * together for a long time, so an approved claim from March and one settled
 * yesterday looked identical.
 *
 * Never stored. "Overdue" is a fact about today rather than about the expense,
 * so a stored copy is wrong by the next morning; it is derived on read from the
 * due date, exactly as an invoice's is.
 */
export const expensePaymentStatusSchema = z.enum(["unpaid", "overdue", "paid"]);
export type ExpensePaymentStatus = z.infer<typeof expensePaymentStatusSchema>;

export const EXPENSE_PAYMENT_STATUS_LABELS: Record<ExpensePaymentStatus, string> = {
  unpaid: "Unpaid",
  overdue: "Overdue",
  paid: "Paid",
};

export const expensePaymentMethodSchema = z.enum([
  "bank_transfer",
  "cash",
  "cheque",
  "card",
  "online",
]);
export type ExpensePaymentMethod = z.infer<typeof expensePaymentMethodSchema>;

export const expenseRecurrenceFrequencySchema = z.enum([
  "weekly",
  "monthly",
  "quarterly",
  "yearly",
]);
export type ExpenseRecurrenceFrequency = z.infer<typeof expenseRecurrenceFrequencySchema>;

export const createExpenseSchema = z.object({
  // Category is a managed-category slug (see expense-category.schema). Kept as a
  // string so custom, org-defined categories validate alongside the defaults.
  category: z.string().min(1, "Category is required"),
  description: z.string().min(1, "Description is required"),
  expenseDate: z.string().min(1, "Expense date is required"),
  amountMinor: z.number().min(0, "Amount must be non-negative"),
  currency: z.string().min(3).max(3).optional(),
  /**
   * What "Other" actually was.
   *
   * Only read when the category is `other`, which is the escape hatch for a
   * spend nothing else describes — and an escape hatch nobody can label just
   * produces a column of claims all saying "Other". Reports still group on the
   * slug, so naming one does not fragment them.
   */
  categoryOther: z.string().max(60).optional().default(""),
  taxPct: z.number().min(0).max(100).default(0),
  /**
   * Whether the amount above already contains the tax.
   *
   * A receipt shows one number; whether it includes VAT depends on the receipt.
   * Either way the net is stored in amountMinor and the gross in totalMinor.
   */
  taxInclusive: z.boolean().optional().default(false),
  paymentAccount: z.string().optional().default(""),
  paymentMethod: expensePaymentMethodSchema.optional(),
  reference: z.string().optional().default(""),
  /**
   * When this should be settled by. Optional, and blank is a real answer: an
   * expense with no date to meet simply never falls overdue, which is better
   * than inventing a deadline nobody agreed to.
   */
  dueDate: z.string().optional(),
  requiresApproval: z.boolean().optional().default(false),
  isRecurring: z.boolean().optional().default(false),
  recurrence: z
    .object({
      frequency: expenseRecurrenceFrequencySchema,
      nextDate: z.string().min(1, "Next date is required"),
      endDate: z.string().optional(),
      isActive: z.boolean().optional().default(true),
    })
    .optional(),
  mileage: z
    .object({
      distanceKm: z.number().positive("Distance must be positive"),
      ratePerKmMinor: z.number().min(0, "Rate must be non-negative"),
    })
    .optional(),
  attachments: z
    .array(
      z.object({
        name: z.string().min(1),
        url: z.string().min(1),
      }),
    )
    .optional()
    .default([]),
  projectName: z.string().optional().default(""),
  /**
   * Which department the spend belongs to.
   *
   * Replaces the free-text cost centre, which was a different spelling of the
   * same department on every claim and so could never be grouped on. The old
   * field stays on records that already carry one rather than being thrown away.
   */
  departmentId: z.string().optional(),
  costCentre: z.string().optional().default(""),
  notes: z.string().optional().default(""),
});
export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;

export const updateExpenseSchema = createExpenseSchema.partial();
export type UpdateExpenseInput = z.infer<typeof updateExpenseSchema>;

export const rejectExpenseSchema = z.object({
  reason: z.string().min(1, "Rejection reason is required"),
});
export type RejectExpenseInput = z.infer<typeof rejectExpenseSchema>;

export const expenseSchema = z.object({
  id: z.string(),
  expenseNumber: z.string(),
  category: z.string(),
  /** Human-readable category name resolved from the managed category list. */
  categoryName: z.string(),
  description: z.string(),
  expenseDate: z.string(),
  amountMinor: z.number(),
  taxPct: z.number(),
  taxInclusive: z.boolean().default(false),
  taxMinor: z.number(),
  totalMinor: z.number(),
  currency: z.string(),
  paymentAccount: z.string(),
  paymentMethod: expensePaymentMethodSchema.optional(),
  reference: z.string(),
  submittedById: z.string(),
  submittedByName: z.string(),
  status: expenseStatusSchema,
  /** When it should be settled by. Blank means it never falls overdue. */
  dueDate: z.string().optional(),
  /** The day it was paid. Absent means it has not been. */
  paidOn: z.string().optional(),
  /** Derived on read, never stored — see expensePaymentStatusSchema. */
  paymentStatus: expensePaymentStatusSchema,
  approvedById: z.string().optional(),
  approvedByName: z.string().optional(),
  approvedAt: z.string().optional(),
  rejectedReason: z.string().optional(),
  isRecurring: z.boolean(),
  recurrence: z
    .object({
      frequency: expenseRecurrenceFrequencySchema,
      nextDate: z.string(),
      endDate: z.string().optional(),
      isActive: z.boolean().default(true),
    })
    .optional(),
  parentExpenseId: z.string().optional(),
  mileage: z
    .object({
      distanceKm: z.number(),
      ratePerKmMinor: z.number(),
      totalMinor: z.number(),
    })
    .optional(),
  attachments: z.array(
    z.object({
      name: z.string(),
      url: z.string(),
      key: z.string().optional(),
      size: z.number().optional(),
      mimeType: z.string().optional(),
      uploadedAt: z.string().optional(),
    }),
  ),
  projectName: z.string(),
  department: departmentRefSchema.nullable().optional(),
  costCentre: z.string(),
  notes: z.string(),
  createdAt: z.string(),
});
export type Expense = z.infer<typeof expenseSchema>;

/**
 * What to store as a claim's category name.
 *
 * The typed name wins for "Other" and nowhere else. Letting it override a real
 * category would allow a claim filed under Rent to call itself Coffee, and the
 * name is what every screen shows — so the slug and the label would disagree
 * about the same claim.
 */
export function resolveCategoryName(category: string, label: string, typed?: string): string {
  if (category !== "other") return label;
  const named = typed?.trim();
  return named ? named.slice(0, 60) : label;
}

/**
 * Recording that an expense was settled.
 *
 * Deliberately not a payments ledger. A vendor bill is settled in instalments
 * often enough to need one; a claim is reimbursed in one go, and a list holding
 * exactly one row forever would be a worse way to say so.
 */
export const markExpensePaidSchema = z.object({
  paidOn: z.string().min(1, "Payment date is required"),
  paymentMethod: expensePaymentMethodSchema.optional(),
  paymentAccount: z.string().max(120).optional(),
  reference: z.string().max(120).optional(),
});
export type MarkExpensePaidInput = z.infer<typeof markExpensePaidSchema>;
