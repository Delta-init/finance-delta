import { Types } from "mongoose";
import {
  DEFAULT_EXPENSE_CATEGORIES,
  type ExpenseCategoryRecord,
} from "@delta/shared";
import { AppError } from "../../lib/http";
import { ExpenseCategory, type ExpenseCategoryDoc } from "./expense-category.model";
import { Expense } from "../expense/expense.model";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function toDTO(doc: ExpenseCategoryDoc, expenseCount = 0): ExpenseCategoryRecord {
  return {
    id: doc._id.toString(),
    name: doc.name,
    slug: doc.slug,
    isSystem: Boolean(doc.isSystem),
    expenseCount,
    createdAt: doc.createdAt.toISOString(),
  };
}

/** Seed the default categories for an org the first time they're needed. Idempotent. */
export async function ensureDefaults(orgId: string): Promise<void> {
  const count = await ExpenseCategory.countDocuments({ organizationId: orgId });
  if (count > 0) return;
  const oid = new Types.ObjectId(orgId);
  await ExpenseCategory.insertMany(
    DEFAULT_EXPENSE_CATEGORIES.map((c) => ({
      organizationId: oid,
      name: c.name,
      slug: c.slug,
      isSystem: true,
    })),
    { ordered: false },
  ).catch(() => {
    // Ignore duplicate-key races from concurrent seeding.
  });
}

/** Map of slug -> display name for an org (seeds defaults if missing). */
export async function categoryNameMap(orgId: string): Promise<Map<string, string>> {
  await ensureDefaults(orgId);
  const rows = await ExpenseCategory.find({ organizationId: orgId }).select("slug name");
  const map = new Map<string, string>();
  for (const r of rows) map.set(r.slug as string, r.name as string);
  return map;
}

export async function listCategories(orgId: string): Promise<ExpenseCategoryRecord[]> {
  await ensureDefaults(orgId);
  const rows = await ExpenseCategory.find({ organizationId: orgId }).sort({ name: 1 });

  // Count non-voided expenses per category slug in one pass.
  const counts = await Expense.aggregate<{ _id: string; n: number }>([
    { $match: { organizationId: new Types.ObjectId(orgId), status: { $ne: "voided" } } },
    { $group: { _id: "$category", n: { $sum: 1 } } },
  ]);
  const countMap = new Map(counts.map((c) => [c._id, c.n]));

  return rows.map((r) => toDTO(r as unknown as ExpenseCategoryDoc, countMap.get(r.slug as string) ?? 0));
}

export async function createCategory(orgId: string, name: string): Promise<ExpenseCategoryRecord> {
  await ensureDefaults(orgId);
  const trimmed = name.trim();
  let base = slugify(trimmed);
  if (!base) base = "category";

  // Ensure a unique slug within the org.
  const existing = new Set(
    (await ExpenseCategory.find({ organizationId: orgId }).select("slug")).map((r) => r.slug as string),
  );
  let slug = base;
  let i = 2;
  while (existing.has(slug)) slug = `${base}_${i++}`;

  const doc = await ExpenseCategory.create({
    organizationId: new Types.ObjectId(orgId),
    name: trimmed,
    slug,
    isSystem: false,
  });
  return toDTO(doc as unknown as ExpenseCategoryDoc, 0);
}

export async function updateCategory(orgId: string, id: string, name: string): Promise<ExpenseCategoryRecord> {
  const doc = await ExpenseCategory.findOne({ _id: id, organizationId: orgId });
  if (!doc) throw new AppError("NOT_FOUND", "Category not found");
  const trimmed = name.trim();
  if (!trimmed) throw new AppError("VALIDATION_ERROR", "Name is required");

  doc.name = trimmed;
  await doc.save();

  // Rename propagates: refresh the denormalized name on all expenses using this slug.
  await Expense.updateMany(
    { organizationId: orgId, category: doc.slug },
    { $set: { categoryName: trimmed } },
  );

  const n = await Expense.countDocuments({ organizationId: orgId, category: doc.slug });
  return toDTO(doc as unknown as ExpenseCategoryDoc, n);
}

export async function deleteCategory(orgId: string, id: string): Promise<{ id: string }> {
  const doc = await ExpenseCategory.findOne({ _id: id, organizationId: orgId });
  if (!doc) throw new AppError("NOT_FOUND", "Category not found");

  const inUse = await Expense.countDocuments({ organizationId: orgId, category: doc.slug, status: { $ne: "voided" } });
  if (inUse > 0) {
    throw new AppError(
      "CONFLICT",
      `Cannot delete "${doc.name}" — it is used by ${inUse} expense${inUse > 1 ? "s" : ""}. Reassign or remove those first.`,
    );
  }

  await doc.deleteOne();
  return { id };
}
