import { Types } from "mongoose";
import {
  EXPENSE_TAXONOMY,
  type CreateExpenseCategoryInput,
  type ExpenseCategoryRecord,
  type UpdateExpenseCategoryInput,
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

interface SubRow { slug: string; name: string; inPnl?: boolean | null }

function subsOf(doc: { subcategories?: unknown }): SubRow[] {
  return ((doc.subcategories ?? []) as SubRow[]).map((s) => ({ slug: s.slug, name: s.name, inPnl: s.inPnl }));
}

function toDTO(doc: ExpenseCategoryDoc, expenseCount = 0, subCounts?: Map<string, number>): ExpenseCategoryRecord {
  return {
    id: doc._id.toString(),
    name: doc.name,
    slug: doc.slug,
    isSystem: Boolean(doc.isSystem),
    inPnl: doc.inPnl !== false,
    subcategories: subsOf(doc).map((s) => ({
      slug: s.slug,
      name: s.name,
      ...(typeof s.inPnl === "boolean" ? { inPnl: s.inPnl } : {}),
      expenseCount: subCounts?.get(s.slug) ?? 0,
    })),
    expenseCount,
    createdAt: doc.createdAt.toISOString(),
  };
}

/** A taxonomy category as a document to insert (system, with its subcategories). */
function taxonomyRow(orgId: string, slug: string) {
  const t = EXPENSE_TAXONOMY.find((c) => c.slug === slug);
  if (!t) return null;
  return {
    organizationId: new Types.ObjectId(orgId),
    name: t.name,
    slug: t.slug,
    isSystem: true,
    inPnl: t.inPnl,
    subcategories: t.subcategories.map((s) => ({ ...s })),
  };
}

/** Seed the taxonomy (2026-10-21) for an org the first time categories are needed. Idempotent. */
export async function ensureDefaults(orgId: string): Promise<void> {
  const count = await ExpenseCategory.countDocuments({ organizationId: orgId });
  if (count > 0) return;
  await ExpenseCategory.insertMany(
    EXPENSE_TAXONOMY.map((c) => taxonomyRow(orgId, c.slug)!),
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

export interface ResolvedCategory {
  category: string;
  categoryName: string;
  subcategory: string | null;
  subcategoryName: string;
}

/**
 * The category and subcategory an expense is filed under, checked against the
 * org's list. A category with subcategories needs one of them, unless
 * `optionalSub` (an edit that leaves an older expense's category as it was);
 * `fallbackSub` is used when none was given (the payroll/advance/… defaults).
 * A taxonomy category missing from the org — one not moved over yet — is added.
 */
export async function resolveExpenseCategory(
  orgId: string,
  category: string,
  subcategory: string | null | undefined,
  opts: { optionalSub?: boolean; fallbackSub?: string } = {},
): Promise<ResolvedCategory> {
  await ensureDefaults(orgId);
  let doc = await ExpenseCategory.findOne({ organizationId: orgId, slug: category });
  if (!doc) {
    const row = taxonomyRow(orgId, category);
    if (row) {
      const { organizationId, slug, ...rest } = row;
      doc = await ExpenseCategory.findOneAndUpdate(
        { organizationId, slug },
        { $setOnInsert: rest },
        { upsert: true, new: true },
      );
    }
  }
  if (!doc) throw new AppError("VALIDATION_ERROR", `Unknown expense category "${category}"`);
  const subs = subsOf(doc);
  const wanted = subcategory?.trim() || null;
  if (wanted) {
    const s = subs.find((x) => x.slug === wanted);
    if (!s) throw new AppError("VALIDATION_ERROR", `"${wanted}" is not a subcategory of ${doc.name}`);
    return { category: doc.slug, categoryName: doc.name, subcategory: s.slug, subcategoryName: s.name };
  }
  const fallback = opts.fallbackSub ? subs.find((x) => x.slug === opts.fallbackSub) : undefined;
  if (fallback) return { category: doc.slug, categoryName: doc.name, subcategory: fallback.slug, subcategoryName: fallback.name };
  if (subs.length && !opts.optionalSub) throw new AppError("VALIDATION_ERROR", `Pick a subcategory of ${doc.name}`);
  return { category: doc.slug, categoryName: doc.name, subcategory: null, subcategoryName: "" };
}

/**
 * Leaves out of a profit-and-loss figure the expenses that aren't expenses there
 * (2026-10-21): a category marked off, unless its subcategory is marked on, and a
 * subcategory marked off. `{}` when everything counts. Cash flow keeps them all.
 */
export async function pnlExpenseFilter(orgId: string): Promise<Record<string, unknown>> {
  await ensureDefaults(orgId);
  const rows = await ExpenseCategory.find({ organizationId: orgId }).select("slug inPnl subcategories").lean();
  const nor: Record<string, unknown>[] = [];
  for (const r of rows) {
    const subs = subsOf(r);
    if (r.inPnl === false) {
      const on = subs.filter((s) => s.inPnl === true).map((s) => s.slug);
      nor.push({ category: r.slug, subcategory: { $nin: on } });
    } else {
      const off = subs.filter((s) => s.inPnl === false).map((s) => s.slug);
      if (off.length) nor.push({ category: r.slug, subcategory: { $in: off } });
    }
  }
  return nor.length ? { $nor: nor } : {};
}

export async function listCategories(orgId: string): Promise<ExpenseCategoryRecord[]> {
  await ensureDefaults(orgId);
  const rows = await ExpenseCategory.find({ organizationId: orgId }).sort({ name: 1 });

  // Count non-voided expenses per category and subcategory in one pass.
  const counts = await Expense.aggregate<{ _id: { c: string; s: string | null }; n: number }>([
    { $match: { organizationId: new Types.ObjectId(orgId), status: { $ne: "voided" } } },
    { $group: { _id: { c: "$category", s: "$subcategory" }, n: { $sum: 1 } } },
  ]);
  const catCount = new Map<string, number>();
  const subCount = new Map<string, Map<string, number>>();
  for (const c of counts) {
    catCount.set(c._id.c, (catCount.get(c._id.c) ?? 0) + c.n);
    if (c._id.s) {
      const m = subCount.get(c._id.c) ?? new Map<string, number>();
      m.set(c._id.s, c.n);
      subCount.set(c._id.c, m);
    }
  }

  return rows.map((r) =>
    toDTO(r as unknown as ExpenseCategoryDoc, catCount.get(r.slug as string) ?? 0, subCount.get(r.slug as string)),
  );
}

/** The subcategory list as it should be: kept slugs for the ones that exist, new unique slugs for new names. */
function buildSubcategories(
  input: NonNullable<UpdateExpenseCategoryInput["subcategories"]>,
  existing: SubRow[],
): SubRow[] {
  // A new one never takes an existing slug, kept or removed, so no expense is moved onto it.
  const known = new Set(existing.map((s) => s.slug));
  const used = new Set<string>();
  const names = new Set<string>();
  const out: SubRow[] = [];
  for (const s of input) {
    const name = s.name.trim();
    const key = name.toLowerCase();
    if (names.has(key)) throw new AppError("VALIDATION_ERROR", `"${name}" is listed twice`);
    names.add(key);
    let slug = s.slug && known.has(s.slug) && !used.has(s.slug) ? s.slug : "";
    if (!slug) {
      const base = slugify(name) || "subcategory";
      slug = base;
      let i = 2;
      while (used.has(slug) || known.has(slug)) slug = `${base}_${i++}`;
    }
    used.add(slug);
    out.push({ slug, name, ...(typeof s.inPnl === "boolean" ? { inPnl: s.inPnl } : {}) });
  }
  return out;
}

export async function createCategory(orgId: string, input: CreateExpenseCategoryInput): Promise<ExpenseCategoryRecord> {
  await ensureDefaults(orgId);
  const trimmed = input.name.trim();
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
    inPnl: input.inPnl !== false,
    subcategories: buildSubcategories(input.subcategories, []),
  });
  return toDTO(doc as unknown as ExpenseCategoryDoc, 0);
}

export async function updateCategory(orgId: string, id: string, input: UpdateExpenseCategoryInput): Promise<ExpenseCategoryRecord> {
  const doc = await ExpenseCategory.findOne({ _id: id, organizationId: orgId });
  if (!doc) throw new AppError("NOT_FOUND", "Category not found");
  const trimmed = input.name.trim();
  if (!trimmed) throw new AppError("VALIDATION_ERROR", "Name is required");

  const before = subsOf(doc);
  const renamedSubs: SubRow[] = [];
  if (input.subcategories) {
    const next = buildSubcategories(input.subcategories, before);
    const kept = new Set(next.map((s) => s.slug));
    for (const gone of before.filter((s) => !kept.has(s.slug))) {
      const n = await Expense.countDocuments({
        organizationId: orgId, category: doc.slug, subcategory: gone.slug, status: { $ne: "voided" },
      });
      if (n > 0) {
        throw new AppError(
          "CONFLICT",
          `Cannot remove "${gone.name}" — it is used by ${n} expense${n > 1 ? "s" : ""}. Move those to another subcategory first.`,
        );
      }
    }
    for (const s of next) {
      const old = before.find((b) => b.slug === s.slug);
      if (old && old.name !== s.name) renamedSubs.push(s);
    }
    doc.set("subcategories", next);
  }
  if (typeof input.inPnl === "boolean") doc.set("inPnl", input.inPnl);
  doc.name = trimmed;
  await doc.save();

  // Rename propagates: refresh the denormalized names on all expenses using this slug.
  await Expense.updateMany(
    { organizationId: orgId, category: doc.slug },
    { $set: { categoryName: trimmed } },
  );
  for (const s of renamedSubs) {
    await Expense.updateMany(
      { organizationId: orgId, category: doc.slug, subcategory: s.slug },
      { $set: { subcategoryName: s.name } },
    );
  }

  const counts = await Expense.aggregate<{ _id: string | null; n: number }>([
    { $match: { organizationId: new Types.ObjectId(orgId), category: doc.slug, status: { $ne: "voided" } } },
    { $group: { _id: "$subcategory", n: { $sum: 1 } } },
  ]);
  const subCounts = new Map(counts.filter((c) => c._id).map((c) => [c._id as string, c.n]));
  const n = counts.reduce((a, c) => a + c.n, 0);
  return toDTO(doc as unknown as ExpenseCategoryDoc, n, subCounts);
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
