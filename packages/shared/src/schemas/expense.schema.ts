import { z } from "zod";

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
  category: expenseCategorySchema,
  description: z.string().min(1, "Description is required"),
  expenseDate: z.string().min(1, "Expense date is required"),
  amountMinor: z.number().min(0, "Amount must be non-negative"),
  currency: z.string().min(3).max(3).optional(),
  taxPct: z.number().min(0).max(100).default(0),
  paymentAccount: z.string().optional().default(""),
  paymentMethod: expensePaymentMethodSchema.optional(),
  reference: z.string().optional().default(""),
  requiresApproval: z.boolean().optional().default(false),
  isRecurring: z.boolean().optional().default(false),
  recurrence: z
    .object({
      frequency: expenseRecurrenceFrequencySchema,
      nextDate: z.string().min(1, "Next date is required"),
      endDate: z.string().optional(),
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
  category: expenseCategorySchema,
  description: z.string(),
  expenseDate: z.string(),
  amountMinor: z.number(),
  taxPct: z.number(),
  taxMinor: z.number(),
  totalMinor: z.number(),
  currency: z.string(),
  paymentAccount: z.string(),
  paymentMethod: expensePaymentMethodSchema.optional(),
  reference: z.string(),
  submittedById: z.string(),
  submittedByName: z.string(),
  status: expenseStatusSchema,
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
  attachments: z.array(z.object({ name: z.string(), url: z.string() })),
  projectName: z.string(),
  costCentre: z.string(),
  notes: z.string(),
  createdAt: z.string(),
});
export type Expense = z.infer<typeof expenseSchema>;
