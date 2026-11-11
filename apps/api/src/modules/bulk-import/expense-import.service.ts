import { Types } from "mongoose";
import {
  computeExpenseTax,
  importKey,
  parseImportDate,
  parseImportMethod,
  parseImportPct,
  type CreateExpenseInput,
  type ExpenseImportInput,
  type ExpenseImportRow,
  type ExpensePaymentMethod,
  type ImportPreview,
  type ImportPreviewRow,
  type ImportResult,
  type ImportResultRow,
} from "@delta/shared";
import { logger } from "../../lib/logger";
import { Expense } from "../expense/expense.model";
import { createExpense } from "../expense/expense.service";
import {
  dayAfter, dayOf, loadImportContext, matchAccount, matchAmount, matchCategory, matchCurrency, matchText, methodOfAccount,
  newImportBatchId, type ImportContext,
} from "./import-lookup";

/*
 * Expenses from a spreadsheet (the user, 2026-11-11: "Import option required in Expenses").
 *
 * Each row is one expense: its date, what it was, its category (and subcategory when the category has them), the total
 * paid with any tax in it, and optionally the account it was paid from. Checked first (preview: nothing written), then
 * made one by one through createExpense — numbering, tax, the account and its bank line all as when typed. Imported
 * rows are history: no one is "typing them in late", so an old date is not sent to a manager (no late actor). They are
 * approved; one with a Paid from account is paid on its date from it (its money-out line in Banking), the rest unpaid.
 *
 * A row the books already have — same day, same total and currency, and the same reference (or, without one on either
 * side, the same description) — is skipped, as is a repeat of an earlier row in the same file. Voided ones don't count.
 */

interface Ready {
  row: number;
  date: string;
  description: string;
  category: string;
  subcategory: string | null;
  categoryName: string;
  subcategoryName: string;
  /** As typed: the total, tax included. */
  amountMinor: number;
  taxPct: number;
  netMinor: number;
  taxMinor: number;
  totalMinor: number;
  currency: string;
  account: { id: string; name: string } | null;
  paymentMethod: ExpensePaymentMethod | null;
  reference: string;
  notes: string;
}

type Checked = { row: number; ok: true; v: Ready } | { row: number; ok: false; message: string; seen: Partial<ImportPreviewRow> };

function checkRow(ctx: ImportContext, r: ExpenseImportRow, fmt: ExpenseImportInput["dateFormat"]): Checked {
  const problems: string[] = [];
  const take = <T>(m: { ok: true; value: T } | { ok: false; message: string }): T | undefined => {
    if (m.ok) return m.value;
    problems.push(m.message);
    return undefined;
  };
  const d = parseImportDate(r.date, fmt);
  if (!d.ok) problems.push(r.date.trim() ? d.reason : "No date");
  const description = take(matchText(r.description, "Description", 500, true));
  const cat = take(matchCategory(ctx, r.category, r.subcategory));
  const amount = take(matchAmount(r.amount));
  const pct = parseImportPct(r.taxPct);
  if (!pct.ok) problems.push(pct.reason);
  const currency = take(matchCurrency(r.currency, ctx.baseCurrency));
  const method = parseImportMethod(r.paymentMethod);
  if (!method.ok) problems.push(method.reason);
  const account = r.paidFrom.trim() && currency ? take(matchAccount(ctx, r.paidFrom, currency, "expense")) : undefined;
  const reference = take(matchText(r.reference, "Reference", 120));
  const notes = take(matchText(r.notes, "Notes", 2000));

  if (problems.length || !d.ok || description === undefined || !cat || amount === undefined || !pct.ok || !currency || !method.ok
    || reference === undefined || notes === undefined) {
    return { row: r.row, ok: false, message: problems.join(" · "), seen: { date: d.ok ? d.iso : undefined, description: r.description.trim() || undefined } };
  }
  const taxPct = pct.pct ?? 0;
  // The amount is what was paid: with a tax rate, the tax is inside it.
  const tax = computeExpenseTax(amount, taxPct, true);
  return {
    row: r.row,
    ok: true,
    v: {
      row: r.row, date: d.iso, description, ...cat, amountMinor: amount, taxPct,
      netMinor: tax.netMinor, taxMinor: tax.taxMinor, totalMinor: tax.totalMinor, currency,
      account: account ? { id: account.id, name: account.name } : null,
      paymentMethod: method.method ?? (account ? methodOfAccount(account) : null),
      reference, notes,
    },
  };
}

/** What a duplicate is compared on. */
interface Seen {
  date: string;
  totalMinor: number;
  currency: string;
  reference: string;
  description: string;
  id?: string;
  number?: string;
  row?: number;
}

function same(a: Seen, b: Seen): boolean {
  if (a.date !== b.date || a.totalMinor !== b.totalMinor || a.currency !== b.currency) return false;
  return a.reference && b.reference ? importKey(a.reference) === importKey(b.reference) : importKey(a.description) === importKey(b.description);
}

/** The organization's expenses a row could repeat: on the rows' days, for their totals, not voided. */
async function existingFor(orgId: string, ready: Ready[]): Promise<Seen[]> {
  if (!ready.length) return [];
  const days = ready.map((v) => v.date).sort();
  const rows = await Expense.find({
    organizationId: new Types.ObjectId(orgId),
    status: { $ne: "voided" },
    expenseDate: { $gte: new Date(`${days[0]}T00:00:00.000Z`), $lt: dayAfter(days.at(-1)!) },
    totalMinor: { $in: [...new Set(ready.map((v) => v.totalMinor))] },
  }).select("expenseNumber expenseDate totalMinor currency reference description").lean<any[]>();
  return rows.map((e) => ({
    date: dayOf(e.expenseDate), totalMinor: e.totalMinor ?? 0, currency: String(e.currency ?? "AED"),
    reference: String(e.reference ?? ""), description: String(e.description ?? ""), id: String(e._id), number: String(e.expenseNumber ?? ""),
  }));
}

const seenOf = (v: Ready): Seen => ({ date: v.date, totalMinor: v.totalMinor, currency: v.currency, reference: v.reference, description: v.description, row: v.row });

function duplicateMessage(d: Seen): string {
  if (d.number && d.row) return `Same as row ${d.row} (${d.number})`;
  return d.number ? `Already entered as ${d.number}` : `Same as row ${d.row}`;
}

function view(v: Ready): ImportPreviewRow {
  return {
    row: v.row, status: "ok", date: v.date, description: v.description, categoryName: v.categoryName,
    ...(v.subcategoryName ? { subcategoryName: v.subcategoryName } : {}),
    netMinor: v.netMinor, taxMinor: v.taxMinor, totalMinor: v.totalMinor, taxPct: v.taxPct, currency: v.currency,
    ...(v.account ? { accountName: v.account.name } : {}),
    ...(v.paymentMethod ? { paymentMethod: v.paymentMethod } : {}),
    ...(v.reference ? { reference: v.reference } : {}),
  };
}

/** Every row checked against the books and the rows above it. Writes nothing. */
export async function previewExpenseImport(orgId: string, input: ExpenseImportInput): Promise<ImportPreview> {
  const ctx = await loadImportContext(orgId);
  const checked = input.rows.map((r) => checkRow(ctx, r, input.dateFormat));
  const existing = await existingFor(orgId, checked.flatMap((c) => (c.ok ? [c.v] : [])));
  const earlier: Seen[] = [];
  const rows = checked.map((c): ImportPreviewRow => {
    if (!c.ok) return { row: c.row, status: "error", message: c.message, ...c.seen };
    const me = seenOf(c.v);
    const dup = existing.find((e) => same(e, me)) ?? earlier.find((e) => same(e, me));
    if (dup) return { ...view(c.v), status: "duplicate", message: duplicateMessage(dup), duplicateOf: { id: dup.id, number: dup.number, row: dup.row } };
    earlier.push(me);
    return view(c.v);
  });
  return { rows, counts: countStatuses(rows), newVendors: [] };
}

export function countStatuses(rows: { status: string }[]) {
  return {
    ok: rows.filter((r) => r.status === "ok").length,
    duplicate: rows.filter((r) => r.status === "duplicate").length,
    error: rows.filter((r) => r.status === "error").length,
  };
}

/**
 * The good rows made, each through createExpense, in the file's order; the others reported. A row that fails while
 * being made does not stop the rest. A repeat of an earlier row is skipped only when that row was made.
 */
export async function importExpenses(orgId: string, userId: string, input: ExpenseImportInput): Promise<ImportResult> {
  const ctx = await loadImportContext(orgId);
  const batchId = input.batchId ?? newImportBatchId();
  const checked = input.rows.map((r) => checkRow(ctx, r, input.dateFormat));
  const existing = await existingFor(orgId, checked.flatMap((c) => (c.ok ? [c.v] : [])));
  const results: ImportResultRow[] = [];
  for (const c of checked) {
    if (!c.ok) {
      results.push({ row: c.row, status: "error", message: c.message });
      continue;
    }
    const v = c.v;
    const me = seenOf(v);
    const dup = existing.find((e) => same(e, me));
    if (dup) {
      results.push({ row: v.row, status: "duplicate", message: duplicateMessage(dup), ...(dup.id ? { id: dup.id } : {}), ...(dup.number ? { number: dup.number } : {}) });
      continue;
    }
    try {
      const form: CreateExpenseInput = {
        category: v.category,
        subcategory: v.subcategory ?? undefined,
        description: v.description,
        expenseDate: v.date,
        amountMinor: v.amountMinor,
        currency: v.currency,
        categoryOther: "",
        taxPct: v.taxPct,
        taxInclusive: v.taxPct > 0,
        paymentAccount: "",
        // Named, it is paid from it on its date; left out, the form's own rule (its method's account) applies.
        ...(v.account ? { bankAccountId: v.account.id, paidOn: v.date } : {}),
        ...(v.paymentMethod ? { paymentMethod: v.paymentMethod } : {}),
        reference: v.reference,
        requiresApproval: false,
        isRecurring: false,
        attachments: [],
        projectName: "",
        costCentre: "",
        notes: v.notes,
      };
      // No late actor: imported rows are history, not somebody typing an old date in (the user's choice, 2026-11-11).
      const made = await createExpense(orgId, userId, form, undefined);
      await Expense.updateOne({ _id: new Types.ObjectId(made.id), organizationId: new Types.ObjectId(orgId) }, { $set: { importBatchId: batchId } });
      existing.push({ ...me, id: made.id, number: made.expenseNumber });
      results.push({ row: v.row, status: "created", id: made.id, number: made.expenseNumber });
    } catch (err) {
      results.push({ row: v.row, status: "error", message: (err as Error).message || "Could not be created" });
    }
  }
  const counts = {
    created: results.filter((r) => r.status === "created").length,
    duplicate: results.filter((r) => r.status === "duplicate").length,
    error: results.filter((r) => r.status === "error").length,
  };
  logger.info({ orgId, userId, batchId, fileName: input.fileName, rows: input.rows.length, ...counts }, "Expenses imported from a spreadsheet");
  return { batchId, rows: results, counts, newVendors: [] };
}
