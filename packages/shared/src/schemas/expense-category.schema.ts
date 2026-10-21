import { z } from "zod";
import { EXPENSE_TAXONOMY } from "./expense-taxonomy";

/**
 * Org-managed expense categories.
 *
 * Categories are referenced from expenses by a stable `slug` (a plain string
 * stored on each expense), and since 2026-10-21 each has subcategories (an
 * expense keeps `subcategory` too). Every organization's set is the taxonomy
 * (expense-taxonomy.ts); the old flat seven were moved onto it by a script.
 * Renaming a category changes its display `name` only (slug stays), so the
 * rename propagates everywhere; deleting a category that is still in use is
 * blocked by the API.
 */

/** The set every organization starts with since 2026-10-21: the 17 categories of the taxonomy (with subcategories). */
export const DEFAULT_EXPENSE_CATEGORIES = EXPENSE_TAXONOMY.map((c) => ({ slug: c.slug, name: c.name }));

/** A subcategory as the categories page sends it: an existing one by its slug (renamed or not), a new one by name. */
export const expenseSubcategoryInputSchema = z.object({
  slug: z.string().trim().max(60).optional(),
  name: z.string().trim().min(1, "Name the subcategory").max(60),
  /** Counts in the profit and loss; unset follows the category. */
  inPnl: z.boolean().optional(),
});

export const createExpenseCategorySchema = z.object({
  name: z.string().min(1, "Name is required").max(60),
  /** Counts in the profit and loss (2026-10-21) — off for what isn't an expense (advances receivable, VAT …). */
  inPnl: z.boolean().optional().default(true),
  /** At least one: an expense is filed under one (and a category without any is one from before, which the backfill moves). */
  subcategories: z.array(expenseSubcategoryInputSchema).min(1, "Add at least one subcategory").max(40),
});
export type CreateExpenseCategoryInput = z.infer<typeof createExpenseCategorySchema>;

export const updateExpenseCategorySchema = z.object({
  name: z.string().min(1, "Name is required").max(60),
  inPnl: z.boolean().optional(),
  /** The whole list as it should be: missing ones are removed (refused while expenses use them). */
  subcategories: z.array(expenseSubcategoryInputSchema).min(1, "Keep at least one subcategory").max(40).optional(),
});
export type UpdateExpenseCategoryInput = z.infer<typeof updateExpenseCategorySchema>;

export const expenseCategoryRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  isSystem: z.boolean(),
  /** Counts in the profit and loss (2026-10-21). */
  inPnl: z.boolean().default(true),
  /** Its subcategories, each with how many expenses use it. */
  subcategories: z.array(z.object({ slug: z.string(), name: z.string(), inPnl: z.boolean().optional(), expenseCount: z.number().default(0) })).default([]),
  /** Number of expenses currently referencing this category. */
  expenseCount: z.number().default(0),
  createdAt: z.string(),
});
export type ExpenseCategoryRecord = z.infer<typeof expenseCategoryRecordSchema>;
