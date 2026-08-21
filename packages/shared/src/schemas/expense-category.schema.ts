import { z } from "zod";

/**
 * Org-managed expense categories.
 *
 * Categories are referenced from expenses by a stable `slug` (a plain string
 * stored on each expense). The 7 legacy enum values are seeded as system
 * defaults so existing expenses keep resolving without any data migration.
 * Renaming a category changes its display `name` only (slug stays), so the
 * rename propagates everywhere; deleting a category that is still in use is
 * blocked by the API.
 */

export const DEFAULT_EXPENSE_CATEGORIES = [
  { slug: "salaries_wages", name: "Salaries & Wages" },
  { slug: "commissions", name: "Commissions" },
  { slug: "rent", name: "Rent" },
  { slug: "utilities", name: "Utilities" },
  { slug: "travel", name: "Travel" },
  { slug: "marketing", name: "Marketing" },
  { slug: "other", name: "Other" },
] as const;

export const createExpenseCategorySchema = z.object({
  name: z.string().min(1, "Name is required").max(60),
});
export type CreateExpenseCategoryInput = z.infer<typeof createExpenseCategorySchema>;

export const updateExpenseCategorySchema = z.object({
  name: z.string().min(1, "Name is required").max(60),
});
export type UpdateExpenseCategoryInput = z.infer<typeof updateExpenseCategorySchema>;

export const expenseCategoryRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  isSystem: z.boolean(),
  /** Number of expenses currently referencing this category. */
  expenseCount: z.number().default(0),
  createdAt: z.string(),
});
export type ExpenseCategoryRecord = z.infer<typeof expenseCategoryRecordSchema>;
