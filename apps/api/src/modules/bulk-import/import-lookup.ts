import { randomBytes } from "node:crypto";
import { Types } from "mongoose";
import { EXPENSE_TAXONOMY, importKey, parseAmount, type ExpensePaymentMethod } from "@delta/shared";
import { ExpenseCategory } from "../expense-category/expense-category.model";
import { ensureDefaults } from "../expense-category/expense-category.service";
import { BankAccount } from "../banking/bank-account.model";
import { Organization } from "../organization/organization.model";

/*
 * What an import row is matched against (2026-11-11): the organization's expense categories, its accounts and its
 * currency — read once per file, so checking a thousand rows is a few reads, not thousands. Everything here only reads;
 * the rows are created afterwards through the same services as the forms, which check again.
 */

interface CategoryRow {
  slug: string;
  name: string;
  subcategories: { slug: string; name: string }[];
}

interface AccountRow {
  id: string;
  name: string;
  currency: string;
  type: string;
  active: boolean;
}

export interface ImportContext {
  baseCurrency: string;
  categories: CategoryRow[];
  accounts: AccountRow[];
}

export async function loadImportContext(orgId: string): Promise<ImportContext> {
  await ensureDefaults(orgId);
  const [org, cats, accounts] = await Promise.all([
    Organization.findById(orgId).select("baseCurrency").lean<{ baseCurrency?: string } | null>(),
    ExpenseCategory.find({ organizationId: orgId }).select("slug name subcategories").lean<any[]>(),
    BankAccount.find({ organizationId: new Types.ObjectId(orgId) }).select("accountName currency accountType isActive").lean<any[]>(),
  ]);
  const categories: CategoryRow[] = cats.map((c) => ({
    slug: String(c.slug),
    name: String(c.name),
    subcategories: ((c.subcategories ?? []) as { slug: string; name: string }[]).map((s) => ({ slug: s.slug, name: s.name })),
  }));
  // A taxonomy category the organization has not got yet is added the first time it is used (resolveExpenseCategory).
  for (const t of EXPENSE_TAXONOMY) {
    if (!categories.some((c) => c.slug === t.slug)) {
      categories.push({ slug: t.slug, name: t.name, subcategories: t.subcategories.map((s) => ({ slug: s.slug, name: s.name })) });
    }
  }
  return {
    baseCurrency: (org?.baseCurrency || "AED").toUpperCase(),
    categories,
    accounts: accounts.map((a) => ({
      id: String(a._id), name: String(a.accountName ?? ""), currency: String(a.currency ?? ""), type: String(a.accountType ?? ""), active: a.isActive !== false,
    })),
  };
}

const slugify = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
const quoted = (s: string) => `'${s.trim()}'`;

/** Matches a name or slug, any case: "Travel & Transportation", "travel_transport". */
function sameName(raw: string, row: { slug: string; name: string }): boolean {
  const k = importKey(raw);
  return importKey(row.name) === k || row.slug === k || (!!slugify(raw) && row.slug === slugify(raw));
}

export type Matched<T> = { ok: true; value: T } | { ok: false; message: string };

export interface MatchedCategory {
  category: string;
  categoryName: string;
  subcategory: string | null;
  subcategoryName: string;
}

/** The category and subcategory a row names. A category with subcategories needs one of them. */
export function matchCategory(ctx: ImportContext, rawCategory: string, rawSub: string): Matched<MatchedCategory> {
  if (!rawCategory.trim()) return { ok: false, message: "No category" };
  const cat = ctx.categories.find((c) => sameName(rawCategory, c));
  if (!cat) return { ok: false, message: `Category ${quoted(rawCategory)} not found` };
  if (!cat.subcategories.length) {
    if (rawSub.trim()) return { ok: false, message: `${cat.name} has no subcategories — ${quoted(rawSub)} not found` };
    return { ok: true, value: { category: cat.slug, categoryName: cat.name, subcategory: null, subcategoryName: "" } };
  }
  if (!rawSub.trim()) return { ok: false, message: `Subcategory required for ${cat.name}` };
  const sub = cat.subcategories.find((s) => sameName(rawSub, s));
  if (!sub) return { ok: false, message: `Subcategory ${quoted(rawSub)} not found in ${cat.name}` };
  return { ok: true, value: { category: cat.slug, categoryName: cat.name, subcategory: sub.slug, subcategoryName: sub.name } };
}

/**
 * The account a row says it was paid from, by its name (any case). It has to be open and in the row's currency — one
 * in another currency would be left out of the account by the service, which an import should say up front.
 */
export function matchAccount(ctx: ImportContext, raw: string, currency: string, what: string): Matched<AccountRow> {
  const k = importKey(raw);
  const named = ctx.accounts.filter((a) => importKey(a.name) === k);
  if (!named.length) return { ok: false, message: `Account ${quoted(raw)} not found` };
  const open = named.filter((a) => a.active);
  if (open.length > 1) return { ok: false, message: `More than one account is called ${quoted(raw)}` };
  const acc = open[0] ?? named[0]!;
  if (!acc.active) return { ok: false, message: `${acc.name} is closed` };
  if (acc.currency !== currency) return { ok: false, message: `${acc.name} is in ${acc.currency}, this ${what} is in ${currency}` };
  return { ok: true, value: acc };
}

/** How a payment from this account was made, when the row does not say: petty cash is cash, anything else a transfer. */
export function methodOfAccount(acc: { type: string }): ExpensePaymentMethod {
  return acc.type === "petty_cash" ? "cash" : "bank_transfer";
}

/** A currency code, or the default when blank. */
export function matchCurrency(raw: string, fallback: string): Matched<string> {
  const v = raw.trim().toUpperCase();
  if (!v) return { ok: true, value: fallback };
  if (!/^[A-Z]{3}$/.test(v)) return { ok: false, message: `Currency ${quoted(raw)} is not a 3-letter code` };
  return { ok: true, value: v };
}

/** An amount in minor units: more than nothing. */
export function matchAmount(raw: string): Matched<number> {
  if (!raw.trim()) return { ok: false, message: "No amount" };
  const a = parseAmount(raw, "dot");
  if (!a.ok) return { ok: false, message: a.reason ?? `Amount ${quoted(raw)} is not a number` };
  if (a.minor <= 0) return { ok: false, message: `Amount ${raw.trim()} must be more than 0` };
  return { ok: true, value: a.minor };
}

/** A text cell no longer than a record takes. */
export function matchText(raw: string, label: string, max: number, required = false): Matched<string> {
  const v = raw.trim();
  if (required && !v) return { ok: false, message: `No ${label.toLowerCase()}` };
  if (v.length > max) return { ok: false, message: `${label} is longer than ${max} characters` };
  return { ok: true, value: v };
}

/** One import's id, kept on everything it makes: `imp-20261111-a1b2c3`. */
export function newImportBatchId(): string {
  return `imp-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomBytes(3).toString("hex")}`;
}

/** The day after an ISO day, for a range that takes the whole of the last one. */
export function dayAfter(iso: string): Date {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

export const dayOf = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : "");
