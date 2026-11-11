import { z } from "zod";
import { parseDate } from "../statement";
import { expensePaymentMethodSchema, type ExpensePaymentMethod } from "./expense.schema";

/*
 * Importing bills and expenses from a spreadsheet (the user, 2026-11-11: "Import option required in Bills" / "…in
 * Expenses"). The browser reads the file and sends each row's cells as text, mapped to the fields below; the API
 * checks every row (POST …/import/preview, which writes nothing) and then creates the good ones one by one through the
 * same services as the forms (POST …/import). Rows are independent: one bad row never stops the others.
 *
 * The parsing helpers here are shared so the Match step can show how a row reads before the API is asked, and the API
 * reads it the same way.
 */

/** At most this many rows in one import. */
export const IMPORT_MAX_ROWS = 1000;

/**
 * How text dates in the file are written. A date like 2026-01-15 or 15-Jan-2026 reads the same either way, and a real
 * Excel date cell is turned into 2026-01-15 by the browser before it is sent — this only decides 03/04/2026.
 */
export const importDateFormatSchema = z.enum(["dmy", "mdy"]);
export type ImportDateFormat = z.infer<typeof importDateFormatSchema>;

export const IMPORT_DATE_FORMAT_LABELS: Record<ImportDateFormat, string> = {
  dmy: "Day/Month/Year (15/01/2026)",
  mdy: "Month/Day/Year (01/15/2026)",
};

/** One field a column can be matched to: the template's heading, whether it must be there, and headings it goes by. */
export interface ImportField<K extends string = string> {
  key: K;
  label: string;
  required: boolean;
  hint?: string;
  /** Other headings that mean this field (lower case), for matching columns by name. */
  aliases: string[];
  /** What the template's example row holds. */
  example: string;
}

// A cell as text. Bounded so a stray paste cannot make a request the API refuses whole; the row's own checks say
// what is too long.
const cell = z.string().max(4000).optional().default("");

/** The row number in the file, for every message about it. */
const rowNumber = z.number().int().min(1);

/** One import's id, on every record it made: `imp-20261111-a1b2c3`. */
export const importBatchIdSchema = z.string().regex(/^imp-\d{8}-[a-f0-9]{6}$/, "Not an import batch");

/** How many rows go in one import request — a large file is sent in parts, so no request runs long. */
export const IMPORT_CHUNK_ROWS = 50;

/* ── Expenses ─────────────────────────────────────────────────────────────────────────────────────────────────────── */

export const EXPENSE_IMPORT_FIELDS = [
  { key: "date", label: "Date", required: true, aliases: ["expense date", "date"], example: "15/01/2026" },
  { key: "description", label: "Description", required: true, aliases: ["description", "details", "particulars", "narration", "memo", "item"], example: "Taxi to client meeting" },
  { key: "category", label: "Category", required: true, hint: "Name or slug of an expense category", aliases: ["category", "expense category"], example: "Travel & Transportation" },
  { key: "subcategory", label: "Subcategory", required: false, hint: "Needed when the category has subcategories", aliases: ["subcategory", "sub category", "sub-category"], example: "Business Taxi" },
  { key: "amount", label: "Amount", required: true, hint: "The total paid, tax included", aliases: ["amount", "total", "total amount", "amount paid"], example: "105.00" },
  { key: "taxPct", label: "Tax %", required: false, hint: "When given, the amount includes it", aliases: ["tax %", "tax", "vat %", "vat", "tax rate", "gst %"], example: "5" },
  { key: "currency", label: "Currency", required: false, hint: "Left blank: the organization's", aliases: ["currency", "ccy"], example: "AED" },
  { key: "paidFrom", label: "Paid from", required: false, hint: "A bank, cash or card account's name — it is then paid on its date", aliases: ["paid from", "account", "bank account", "paid from account"], example: "" },
  { key: "paymentMethod", label: "Payment method", required: false, hint: "Cash, bank transfer, cheque, card or online", aliases: ["payment method", "method", "paid by", "payment mode", "mode"], example: "Cash" },
  { key: "reference", label: "Reference", required: false, aliases: ["reference", "ref", "receipt", "receipt no", "receipt number"], example: "R-1001" },
  { key: "notes", label: "Notes", required: false, aliases: ["notes", "note", "remarks", "comment"], example: "" },
] as const satisfies readonly ImportField[];
export type ExpenseImportFieldKey = (typeof EXPENSE_IMPORT_FIELDS)[number]["key"];

export const expenseImportRowSchema = z.object({
  row: rowNumber,
  date: cell,
  description: cell,
  category: cell,
  subcategory: cell,
  amount: cell,
  taxPct: cell,
  currency: cell,
  paidFrom: cell,
  paymentMethod: cell,
  reference: cell,
  notes: cell,
});
export type ExpenseImportRow = z.infer<typeof expenseImportRowSchema>;

export const expenseImportSchema = z.object({
  dateFormat: importDateFormatSchema.default("dmy"),
  /** The file's name — written to the API's log with the batch. */
  fileName: z.string().max(200).optional().default(""),
  /** A large file goes in parts: the first part's answer names the batch, and the next parts send it back. */
  batchId: importBatchIdSchema.optional(),
  rows: z.array(expenseImportRowSchema)
    .min(1, "The file has no rows to import")
    .max(IMPORT_MAX_ROWS, `At most ${IMPORT_MAX_ROWS} rows at a time — split the file`),
});
export type ExpenseImportInput = z.infer<typeof expenseImportSchema>;

/* ── Bills ────────────────────────────────────────────────────────────────────────────────────────────────────────── */

export const BILL_IMPORT_FIELDS = [
  { key: "vendor", label: "Vendor", required: true, hint: "Matched by name; a new one is added", aliases: ["vendor", "vendor name", "supplier", "supplier name"], example: "Example Supplies LLC" },
  { key: "billNumber", label: "Bill number", required: false, hint: "The vendor's own invoice number", aliases: ["bill number", "bill no", "bill #", "invoice number", "invoice no", "vendor invoice", "vendor bill number", "reference"], example: "INV-2041" },
  { key: "billDate", label: "Bill date", required: true, aliases: ["bill date", "invoice date", "date"], example: "15/01/2026" },
  { key: "dueDate", label: "Due date", required: false, hint: "Left blank: from the vendor's terms, else the bill date", aliases: ["due date", "due", "due on"], example: "14/02/2026" },
  { key: "category", label: "Category", required: true, hint: "Name or slug of an expense category", aliases: ["category", "expense category"], example: "Office Supplies & Pantry" },
  { key: "subcategory", label: "Subcategory", required: false, hint: "Needed when the category has subcategories", aliases: ["subcategory", "sub category", "sub-category"], example: "Stationery" },
  { key: "description", label: "Description", required: true, aliases: ["description", "details", "item", "particulars"], example: "Printer paper, 20 boxes" },
  { key: "amount", label: "Amount", required: true, hint: "Before tax", aliases: ["amount", "net amount", "subtotal", "amount before tax"], example: "1000.00" },
  { key: "taxPct", label: "Tax %", required: false, aliases: ["tax %", "tax", "vat %", "vat", "tax rate", "gst %"], example: "5" },
  { key: "currency", label: "Currency", required: false, hint: "Left blank: the vendor's", aliases: ["currency", "ccy"], example: "AED" },
  { key: "paidOn", label: "Paid on", required: false, hint: "With Paid from: the bill is recorded paid in full", aliases: ["paid on", "payment date", "paid date", "date paid"], example: "" },
  { key: "paidFrom", label: "Paid from", required: false, hint: "A bank, cash or card account's name", aliases: ["paid from", "account", "bank account", "paid from account"], example: "" },
  { key: "paymentMethod", label: "Payment method", required: false, hint: "For the payment; left blank: cash from petty cash, else bank transfer", aliases: ["payment method", "method", "paid by", "payment mode", "mode"], example: "" },
  { key: "notes", label: "Notes", required: false, aliases: ["notes", "note", "remarks", "comment"], example: "" },
] as const satisfies readonly ImportField[];
export type BillImportFieldKey = (typeof BILL_IMPORT_FIELDS)[number]["key"];

export const billImportRowSchema = z.object({
  row: rowNumber,
  vendor: cell,
  billNumber: cell,
  billDate: cell,
  dueDate: cell,
  category: cell,
  subcategory: cell,
  description: cell,
  amount: cell,
  taxPct: cell,
  currency: cell,
  paidOn: cell,
  paidFrom: cell,
  paymentMethod: cell,
  notes: cell,
});
export type BillImportRow = z.infer<typeof billImportRowSchema>;

export const billImportSchema = z.object({
  dateFormat: importDateFormatSchema.default("dmy"),
  fileName: z.string().max(200).optional().default(""),
  batchId: importBatchIdSchema.optional(),
  rows: z.array(billImportRowSchema)
    .min(1, "The file has no rows to import")
    .max(IMPORT_MAX_ROWS, `At most ${IMPORT_MAX_ROWS} rows at a time — split the file`),
});
export type BillImportInput = z.infer<typeof billImportSchema>;

/* ── What the API answers ─────────────────────────────────────────────────────────────────────────────────────────── */

export const importRowStatusSchema = z.enum(["ok", "duplicate", "error"]);
export type ImportRowStatus = z.infer<typeof importRowStatusSchema>;

/** One row checked: what it will be, or why it is left out. Fields a kind does not have are absent. */
export const importPreviewRowSchema = z.object({
  row: z.number(),
  status: importRowStatusSchema,
  /** Why it is an error, or what it duplicates — in words. */
  message: z.string().optional(),
  /** The record or earlier row it repeats. */
  duplicateOf: z.object({ id: z.string().optional(), number: z.string().optional(), row: z.number().optional() }).optional(),
  date: z.string().optional(),
  description: z.string().optional(),
  categoryName: z.string().optional(),
  subcategoryName: z.string().optional(),
  netMinor: z.number().optional(),
  taxMinor: z.number().optional(),
  totalMinor: z.number().optional(),
  taxPct: z.number().optional(),
  currency: z.string().optional(),
  /** The account it is paid from, when it is. */
  accountName: z.string().optional(),
  paymentMethod: z.string().optional(),
  reference: z.string().optional(),
  /* Bills only. */
  vendorName: z.string().optional(),
  /** The vendor is not on file yet and will be added. */
  newVendor: z.boolean().optional(),
  billNumber: z.string().optional(),
  dueDate: z.string().optional(),
  paidOn: z.string().optional(),
});
export type ImportPreviewRow = z.infer<typeof importPreviewRowSchema>;

export const importPreviewSchema = z.object({
  rows: z.array(importPreviewRowSchema),
  counts: z.object({ ok: z.number(), duplicate: z.number(), error: z.number() }),
  /** Bills: vendors not on file, added when imported. */
  newVendors: z.array(z.string()).default([]),
});
export type ImportPreview = z.infer<typeof importPreviewSchema>;

export const importResultRowSchema = z.object({
  row: z.number(),
  status: z.enum(["created", "duplicate", "error"]),
  message: z.string().optional(),
  /** What was made. */
  id: z.string().optional(),
  number: z.string().optional(),
  /** Made, but something after it did not go through (a bill's payment). */
  warning: z.string().optional(),
});
export type ImportResultRow = z.infer<typeof importResultRowSchema>;

export const importResultSchema = z.object({
  /** Kept on every record made, so the batch can be found again. */
  batchId: z.string(),
  rows: z.array(importResultRowSchema),
  counts: z.object({ created: z.number(), duplicate: z.number(), error: z.number() }),
  /** Bills: the vendors that were added. */
  newVendors: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
});
export type ImportResult = z.infer<typeof importResultSchema>;

/* ── Reading cells ────────────────────────────────────────────────────────────────────────────────────────────────── */

/** Trimmed, lower case, inner spaces collapsed — how names are compared. */
export function importKey(s: string | null | undefined): string {
  return String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * A date cell: `2026-01-15` (and `2026/01/15`) and month names (`15-Jan-2026`) are read whatever the format; anything
 * else in the file's format — dd/mm/yyyy unless the Match step says mm/dd/yyyy. A time after it is ignored.
 */
export function parseImportDate(raw: string | null | undefined, format: ImportDateFormat = "dmy"): { ok: true; iso: string } | { ok: false; reason: string } {
  let v = String(raw ?? "").trim();
  if (!v) return { ok: false, reason: "No date" };
  const timed = v.match(/^(.+?)[ T]\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?\s*(am|pm)?\s*(Z|[+-]\d{2}:?\d{2})?$/i);
  if (timed) v = timed[1]!.trim();
  const fmt = /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(v) ? "ymd" : /[a-z]/i.test(v) ? "dMonY" : format;
  const r = parseDate(v, fmt);
  if (!r.ok) return { ok: false, reason: r.reason ?? `"${v}" is not a date` };
  return { ok: true, iso: r.iso };
}

/** A tax rate: `5`, `5%`, `7.5 %`; blank is none. */
export function parseImportPct(raw: string | null | undefined): { ok: true; pct: number | null } | { ok: false; reason: string } {
  const v = String(raw ?? "").trim().replace(/%$/, "").trim();
  if (!v) return { ok: true, pct: null };
  if (!/^\d+(\.\d+)?$/.test(v)) return { ok: false, reason: `Tax % "${String(raw).trim()}" is not a number` };
  const pct = Number(v);
  if (pct > 100) return { ok: false, reason: `Tax % ${pct} is more than 100` };
  return { ok: true, pct };
}

const METHOD_WORDS: Record<string, ExpensePaymentMethod> = {
  "bank transfer": "bank_transfer", "bank_transfer": "bank_transfer", transfer: "bank_transfer", bank: "bank_transfer",
  "wire": "bank_transfer", "wire transfer": "bank_transfer", "neft": "bank_transfer", "rtgs": "bank_transfer", "imps": "bank_transfer",
  cash: "cash", "petty cash": "cash",
  cheque: "cheque", check: "cheque", chq: "cheque",
  card: "card", "credit card": "card", "debit card": "card", "company card": "card",
  online: "online", upi: "online", "online payment": "online",
};

/** A payment method in words — "Bank transfer", "cash", "Card" — or blank. */
export function parseImportMethod(raw: string | null | undefined): { ok: true; method: ExpensePaymentMethod | null } | { ok: false; reason: string } {
  const k = importKey(raw).replace(/[^a-z_ ]/g, " ").replace(/\s+/g, " ").trim();
  if (!k) return { ok: true, method: null };
  const m = METHOD_WORDS[k] ?? (expensePaymentMethodSchema.safeParse(k).success ? (k as ExpensePaymentMethod) : undefined);
  if (!m) return { ok: false, reason: `Payment method "${String(raw).trim()}" — use cash, bank transfer, cheque, card or online` };
  return { ok: true, method: m };
}

/**
 * Which column each field is in, guessed from the headings: an exact heading first (the template's, or one of the
 * field's other names), then a heading that contains one. A column is given to one field only.
 */
export function guessImportColumns<K extends string>(fields: readonly ImportField<K>[], headings: string[]): Partial<Record<K, number>> {
  const heads = headings.map((h) => importKey(h));
  const taken = new Set<number>();
  const out: Partial<Record<K, number>> = {};
  const names = (f: ImportField<K>) => [importKey(f.label), ...f.aliases.map(importKey)];
  for (const f of fields) {
    const i = heads.findIndex((h, idx) => !taken.has(idx) && h && names(f).includes(h));
    if (i >= 0) { out[f.key] = i; taken.add(i); }
  }
  for (const f of fields) {
    if (out[f.key] !== undefined) continue;
    // Longest names first, so "sub category" is not taken by "category".
    const wanted = names(f).filter((n) => n.length > 3).sort((a, b) => b.length - a.length);
    const i = heads.findIndex((h, idx) => !taken.has(idx) && h && wanted.some((n) => h.includes(n)));
    if (i >= 0) { out[f.key] = i; taken.add(i); }
  }
  return out;
}
