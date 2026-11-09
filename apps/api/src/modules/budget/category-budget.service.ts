import { Types } from "mongoose";
import type { CategoryBudget, CategoryBudgetLine, CategoryBudgetQuery, CategoryBudgetRow, UpsertCategoryBudgetInput } from "@delta/shared";
import { AppError } from "../../lib/http";
import { Expense } from "../expense/expense.model";
import { ExpenseCategory } from "../expense-category/expense-category.model";
import { ensureDefaults, pnlExpenseFilter } from "../expense-category/expense-category.service";
import { Organization } from "../organization/organization.model";
import { User } from "../user/user.model";
import { CategoryBudgetModel } from "./budget.model";

/*
 * Budgets by expense category (the user, 2026-11-09: "category-wise, and no department to pick"). A month's amount
 * for a category, or for one of its subcategories, against every approved expense filed there that month — with a
 * department or without (most have none). Only what is spending: the categories and subcategories the P&L counts
 * (advances receivable, payroll clearing, VAT control, loan principal… are not). Months are UTC months of the
 * expense date, as on the department allocations.
 */

interface SubInfo { slug: string; name: string }
interface CatInfo { slug: string; name: string; subs: SubInfo[] }

/** A subcategory counts in the P&L by its own switch when it has one, else by its category's. */
const counts = (catInPnl: boolean | null | undefined, subInPnl?: boolean | null) =>
  typeof subInPnl === "boolean" ? subInPnl : catInPnl !== false;

/** The organization's categories that are spending, each with the subcategories that are, in their own order. */
async function spendingCategories(orgId: string): Promise<CatInfo[]> {
  await ensureDefaults(orgId);
  const rows = await ExpenseCategory.find({ organizationId: orgId }).select("slug name inPnl subcategories").sort({ name: 1 }).lean();
  const out: CatInfo[] = [];
  for (const r of rows) {
    const all = (r.subcategories ?? []) as Array<{ slug: string; name: string; inPnl?: boolean | null }>;
    const subs = all.filter((s) => counts(r.inPnl, s.inPnl)).map((s) => ({ slug: s.slug, name: s.name }));
    // A category off the P&L shows only when one of its subcategories is switched back on.
    if (r.inPnl === false && !subs.length) continue;
    out.push({ slug: r.slug, name: r.name, subs });
  }
  return out;
}

const NO_SUB = "No subcategory";

export async function getCategoryBudget(organizationId: string, query: CategoryBudgetQuery): Promise<CategoryBudgetRow[]> {
  const year = query.month ? Number(query.month.slice(0, 4)) : query.year ?? new Date().getUTCFullYear();
  const month = query.month ? Number(query.month.slice(5, 7)) : undefined;
  const start = new Date(Date.UTC(year, month ? month - 1 : 0, 1));
  const end = new Date(Date.UTC(year, month ?? 12, 1));
  const period = query.month ?? String(year);
  const org = new Types.ObjectId(organizationId);

  const [cats, organization, budgets, pnl] = await Promise.all([
    spendingCategories(organizationId),
    Organization.findById(org).select("baseCurrency").lean(),
    CategoryBudgetModel.find({ organizationId: org, period: query.month ?? { $gte: `${year}-01`, $lte: `${year}-12` }, allocatedMinor: { $gt: 0 } })
      .select("category subcategory period currency allocatedMinor").lean(),
    pnlExpenseFilter(organizationId),
  ]);
  const spend = await Expense.aggregate<{
    _id: { category: string; subcategory: string; currency: string }; amountMinor: number; count: number; categoryName: string; subcategoryName: string;
  }>([
    { $match: { organizationId: org, status: "approved", expenseDate: { $gte: start, $lt: end }, ...pnl } },
    {
      $group: {
        _id: { category: "$category", subcategory: { $ifNull: ["$subcategory", ""] }, currency: "$currency" },
        amountMinor: { $sum: "$totalMinor" }, count: { $sum: 1 },
        categoryName: { $first: "$categoryName" }, subcategoryName: { $first: "$subcategoryName" },
      },
    },
  ]);

  const base = String(organization?.baseCurrency ?? "AED").toUpperCase();
  const catOf = new Map(cats.map((c) => [c.slug, c]));
  type Row = CategoryBudgetRow & { lines: Map<string, CategoryBudgetLine> };
  const rows = new Map<string, Row>();
  const ensure = (category: string, currency: string, fallbackName = ""): Row => {
    const key = `${category}|${currency}`;
    let row = rows.get(key);
    if (!row) {
      const info = catOf.get(category);
      const lines = new Map<string, CategoryBudgetLine>();
      for (const s of info?.subs ?? []) lines.set(s.slug, { subcategory: s.slug, name: s.name, budgeted: false, allocatedMinor: 0, spentMinor: 0, availableMinor: 0, expenses: 0 });
      row = {
        category, categoryName: info?.name || fallbackName || category, currency, period, budgeted: false, budgetFrom: "none",
        allocatedMinor: 0, spentMinor: 0, availableMinor: 0, expenses: 0, subcategories: [], lines,
      };
      rows.set(key, row);
    }
    return row;
  };
  const line = (row: Row, subcategory: string, name = "") => {
    let l = row.lines.get(subcategory);
    if (!l) {
      l = { subcategory, name: name || (subcategory ? subcategory : NO_SUB), budgeted: false, allocatedMinor: 0, spentMinor: 0, availableMinor: 0, expenses: 0 };
      row.lines.set(subcategory, l);
    }
    return l;
  };

  // Every spending category can be budgeted in the organization's own currency, spent in or not.
  for (const c of cats) ensure(c.slug, base);

  /* The budget, month by month: a category's own amount when it has one that month, else what its subcategories'
     add up to — so a year adds up the months, each counted once. */
  const months = new Map<string, { own: number; subs: number }>();
  for (const b of budgets) {
    const row = ensure(b.category, b.currency);
    const sub = b.subcategory ?? "";
    if (sub) {
      const l = line(row, sub);
      l.budgeted = true;
      l.allocatedMinor += b.allocatedMinor;
    }
    const key = `${b.category}|${b.currency}|${b.period}`;
    const m = months.get(key) ?? { own: 0, subs: 0 };
    if (sub) m.subs += b.allocatedMinor; else m.own += b.allocatedMinor;
    months.set(key, m);
  }
  for (const [key, m] of months) {
    const [category, currency] = key.split("|");
    const row = ensure(category!, currency!);
    row.budgeted = true;
    if (m.own > 0) { row.allocatedMinor += m.own; row.budgetFrom = "category"; }
    else { row.allocatedMinor += m.subs; if (row.budgetFrom === "none") row.budgetFrom = "subcategories"; }
  }

  for (const s of spend) {
    const row = ensure(s._id.category, s._id.currency, s.categoryName);
    row.spentMinor += s.amountMinor;
    row.expenses += s.count;
    const l = line(row, s._id.subcategory, s.subcategoryName);
    l.spentMinor += s.amountMinor;
    l.expenses += s.count;
  }

  const order = (c: string) => cats.findIndex((x) => x.slug === c);
  return [...rows.values()]
    .map(({ lines, ...row }) => {
      const subs = [...lines.values()].map((l) => ({ ...l, availableMinor: l.allocatedMinor - l.spentMinor }));
      const info = catOf.get(row.category);
      const rank = (s: string) => { const i = info?.subs.findIndex((x) => x.slug === s) ?? -1; return i < 0 ? 1e6 : i; };
      subs.sort((a, b) => rank(a.subcategory) - rank(b.subcategory) || a.name.localeCompare(b.name));
      return { ...row, availableMinor: row.allocatedMinor - row.spentMinor, subcategories: subs };
    })
    .sort((a, b) => Number(a.currency !== base) - Number(b.currency !== base) || a.currency.localeCompare(b.currency)
      || (order(a.category) < 0 ? 1e6 : order(a.category)) - (order(b.category) < 0 ? 1e6 : order(b.category))
      || a.categoryName.localeCompare(b.categoryName));
}

function budgetDTO(row: any, names: Map<string, CatInfo>): CategoryBudget {
  const info = names.get(row.category);
  const sub = row.subcategory ?? "";
  return {
    id: String(row._id), category: row.category, categoryName: info?.name ?? row.category,
    subcategory: sub, subcategoryName: sub ? info?.subs.find((s) => s.slug === sub)?.name ?? sub : "",
    period: row.period, currency: row.currency, allocatedMinor: row.allocatedMinor, note: row.note ?? "",
    updatedByName: row.updatedByName, updatedAt: new Date(row.updatedAt).toISOString(),
    changes: (row.changes ?? []).map((c: any) => ({ allocatedMinor: c.allocatedMinor, note: c.note ?? "", changedByName: c.changedByName, changedAt: new Date(c.changedAt).toISOString() })),
  };
}

/** The year's category budgets with their history — for the dialog that sets them. */
export async function listCategoryBudgets(organizationId: string, year: number): Promise<CategoryBudget[]> {
  const [cats, rows] = await Promise.all([
    spendingCategories(organizationId),
    CategoryBudgetModel.find({ organizationId: new Types.ObjectId(organizationId), period: { $gte: `${year}-01`, $lte: `${year}-12` } }).sort({ period: 1 }).lean(),
  ]);
  const names = new Map(cats.map((c) => [c.slug, c]));
  return rows.map((r) => budgetDTO(r, names));
}

/** Set a category's (or a subcategory's) month. 0 takes the budget off; the change is kept either way. */
export async function upsertCategoryBudget(organizationId: string, userId: string, input: UpsertCategoryBudgetInput): Promise<CategoryBudget> {
  await ensureDefaults(organizationId);
  const [category, user] = await Promise.all([
    ExpenseCategory.findOne({ organizationId, slug: input.category }).select("slug name inPnl subcategories").lean(),
    User.findOne({ _id: userId, "memberships.organizationId": organizationId }).select("name").lean(),
  ]);
  if (!category) throw new AppError("VALIDATION_ERROR", `Unknown expense category "${input.category}"`);
  if (!user) throw new AppError("FORBIDDEN", "User membership not found");
  const sub = input.subcategory || "";
  const subDoc = sub ? ((category.subcategories ?? []) as Array<{ slug: string; name: string; inPnl?: boolean | null }>).find((s) => s.slug === sub) : undefined;
  if (sub && !subDoc) throw new AppError("VALIDATION_ERROR", `"${sub}" is not a subcategory of ${category.name}`);
  if (sub ? !counts(category.inPnl, subDoc?.inPnl) : category.inPnl === false) {
    throw new AppError("VALIDATION_ERROR", `${subDoc?.name ?? category.name} is not in the profit and loss — it isn't spending, so it takes no budget`);
  }

  const filter = { organizationId: new Types.ObjectId(organizationId), category: category.slug, subcategory: sub, period: input.period, currency: input.currency };
  const update = {
    $set: { allocatedMinor: input.allocatedMinor, note: input.note, updatedById: new Types.ObjectId(userId), updatedByName: user.name },
    $push: { changes: { allocatedMinor: input.allocatedMinor, note: input.note, changedById: new Types.ObjectId(userId), changedByName: user.name, changedAt: new Date() } },
  };
  let row;
  try {
    row = await CategoryBudgetModel.findOneAndUpdate(filter, update, { new: true, upsert: true, setDefaultsOnInsert: true }).lean();
  } catch (error) {
    // Two first-time saves of the same month race on the unique key: the loser saves as an update, both kept in the log.
    if ((error as { code?: number }).code !== 11000) throw error;
    row = await CategoryBudgetModel.findOneAndUpdate(filter, update, { new: true }).lean();
  }
  const names = new Map(await spendingCategories(organizationId).then((cs) => cs.map((c) => [c.slug, c] as const)));
  return budgetDTO(row!, names);
}
