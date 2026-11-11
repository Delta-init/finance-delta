import { z } from "zod";

/**
 * Manual payroll (the user, 2026-11-11: "In Payroll section there is no option to create or import data, still blank
 * page shows").
 *
 * An organization whose payroll is not run through HRMS — the Bangalore book, kept in rupees — enters its months in
 * finance: a person at a time, or a whole sheet imported from Excel or CSV. Which organizations do that is a setting
 * (Settings → Payroll, `payrollMode`); every organization starts on HRMS and stays exactly as it was.
 *
 * Shared, like the statement parser: the browser reads the file and shows what is wrong with each row before anything
 * is sent, and the API checks every row again on the way in by the same rules — so the preview and what is created
 * can never disagree, and a hand-made request cannot slip in a row the preview would have refused.
 *
 * Every amount is integer minor units. Nothing here guesses: a cell that cannot be read as an amount, a net that is
 * not gross less deductions, a negative net — each is reported against its row, never adjusted to fit.
 */

/** Where an organization's payroll comes from: HR submits each month ("hrms"), or finance enters it ("manual"). */
export const PAYROLL_MODES = ["hrms", "manual"] as const;
export type PayrollMode = (typeof PAYROLL_MODES)[number];

/** What a manual line's pay is broken down into on the way out. Stored under these labels, read back by them. */
export const MANUAL_DEDUCTIONS = [
  { key: "pf", label: "PF" },
  { key: "esi", label: "ESI" },
  { key: "professionalTax", label: "Professional tax" },
  { key: "tds", label: "TDS (income tax)" },
  { key: "other", label: "Other deductions" },
] as const;
export type ManualDeductionKey = (typeof MANUAL_DEDUCTIONS)[number]["key"];

/** The one earning a manual line carries: its gross, as entered. */
export const MANUAL_GROSS_LABEL = "Gross pay";

/** A stored deduction's key, from its label; null for a label that is not one of the named items. */
export function manualDeductionKey(label: string): ManualDeductionKey | null {
  return MANUAL_DEDUCTIONS.find((d) => d.label === label)?.key ?? null;
}

// Bounded so a typo of twelve zeros is a refusal, not a number; signed so a negative is reported, not rejected unread.
const amount = z.number().int().min(-1e13).max(1e13);

/**
 * One person on a manual month, as typed or as read from a file. Loose on purpose — an empty name or a negative
 * deduction parses, and `checkManualPayrollLine` says what is wrong with it, so an import can create the good rows and
 * list the bad ones rather than refusing the whole sheet over one cell.
 */
export const manualPayrollLineSchema = z.object({
  /** The row it came from in the file, to say which one is wrong. */
  rowNo: z.number().int().min(1).max(1_000_000).optional(),
  employeeCode: z.string().trim().max(40).default(""),
  name: z.string().trim().max(120).default(""),
  departmentName: z.string().trim().max(120).default(""),
  designation: z.string().trim().max(120).default(""),
  /** What this person is paid in: the month's currency, which it is when left empty. Any other is flagged. */
  currency: z.string().trim().max(10).default(""),
  bankName: z.string().trim().max(120).default(""),
  accountNumber: z.string().trim().max(40).default(""),
  ifsc: z.string().trim().max(20).default(""),
  grossMinor: amount,
  deductions: z
    .object({
      pf: amount.optional(),
      esi: amount.optional(),
      professionalTax: amount.optional(),
      tds: amount.optional(),
      other: amount.optional(),
    })
    .default({}),
  /** Net as the file states it, when it has a Net column. Must agree with gross less deductions, or the row is flagged. */
  netMinor: amount.nullable().optional(),
});
export type ManualPayrollLineInput = z.input<typeof manualPayrollLineSchema>;
export type ManualPayrollLine = z.output<typeof manualPayrollLineSchema>;

/** "45,000.00": for messages about one row, where the currency is already known. */
const plain = (minor: number) =>
  (minor / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export interface ManualLineCheck {
  /** Empty when the line can be created. */
  problems: string[];
  /** Its own currency, or the month's. */
  currency: string;
  grossMinor: number;
  /** The named deductions it has, in order, zeros left out. */
  deductions: Array<{ key: ManualDeductionKey; label: string; amountMinor: number }>;
  deductionsMinor: number;
  /** Gross less deductions: what the person is paid. */
  netMinor: number;
}

/** What is wrong with one line, and its figures worked out. `monthCurrency` is the run's. */
export function checkManualPayrollLine(line: ManualPayrollLine, monthCurrency: string): ManualLineCheck {
  const problems: string[] = [];
  if (!line.name.trim()) problems.push("Name is missing");

  // A manual month is in one currency — one month per currency (the user, 2026-11-11) — so somebody paid in another
  // belongs on that currency's month, and is flagged here rather than added to a total they don't belong in.
  const month = monthCurrency.trim().toUpperCase();
  const currency = (line.currency.trim() || month).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) problems.push(`Currency "${line.currency}" is not a 3-letter code (INR, AED…)`);
  else if (currency !== month) problems.push(`Paid in ${currency}, but this month is in ${month} — put them on the ${currency} month`);

  const grossMinor = line.grossMinor;
  if (grossMinor === 0) problems.push("Gross pay is missing");
  else if (grossMinor < 0) problems.push("Gross pay can't be negative");

  const deductions: ManualLineCheck["deductions"] = [];
  for (const d of MANUAL_DEDUCTIONS) {
    const v = line.deductions[d.key] ?? 0;
    if (v < 0) problems.push(`${d.label} can't be negative`);
    else if (v > 0) deductions.push({ key: d.key, label: d.label, amountMinor: v });
  }
  const deductionsMinor = deductions.reduce((a, d) => a + d.amountMinor, 0);
  const netMinor = grossMinor - deductionsMinor;

  if (grossMinor > 0 && netMinor < 0) {
    problems.push(`Net pay would be negative: gross ${plain(grossMinor)} less deductions ${plain(deductionsMinor)}`);
  }
  if (line.netMinor !== null && line.netMinor !== undefined && line.netMinor !== netMinor) {
    problems.push(`Net in the file is ${plain(line.netMinor)}, but gross less deductions is ${plain(netMinor)}`);
  }
  return { problems, currency, grossMinor, deductions, deductionsMinor, netMinor };
}

export interface ManualCurrencyTotals {
  currency: string;
  employeeCount: number;
  grossMinor: number;
  deductionsMinor: number;
  netMinor: number;
}

export interface ManualRowsCheck {
  rows: Array<{ rowNo: number; line: ManualPayrollLine; check: ManualLineCheck }>;
  good: number;
  bad: number;
  /** The rows that can be created, totalled per currency (a manual month has one, so at most one row). */
  byCurrency: ManualCurrencyTotals[];
}

const codeKey = (code: string) => code.trim().toLowerCase();

/**
 * Every row of an import, checked together: each on its own, and an employee code only once — in the file, and against
 * the people already on the month (`existingCodes`). A code is optional; an empty one is never a duplicate.
 */
export function checkManualPayrollRows(
  lines: ManualPayrollLine[],
  monthCurrency: string,
  existingCodes: string[] = [],
): ManualRowsCheck {
  const onMonth = new Set(existingCodes.map(codeKey).filter(Boolean));
  const firstRow = new Map<string, number>();
  const rows = lines.map((line, i) => {
    const rowNo = line.rowNo ?? i + 1;
    const check = checkManualPayrollLine(line, monthCurrency);
    const code = codeKey(line.employeeCode);
    if (code) {
      if (onMonth.has(code)) check.problems.push(`Employee code ${line.employeeCode} is already on this month`);
      else if (firstRow.has(code)) check.problems.push(`Employee code ${line.employeeCode} is on row ${firstRow.get(code)} too`);
      else firstRow.set(code, rowNo);
    }
    return { rowNo, line, check };
  });

  const totals = new Map<string, ManualCurrencyTotals>();
  for (const { check } of rows) {
    if (check.problems.length) continue;
    const t = totals.get(check.currency) ?? { currency: check.currency, employeeCount: 0, grossMinor: 0, deductionsMinor: 0, netMinor: 0 };
    t.employeeCount += 1;
    t.grossMinor += check.grossMinor;
    t.deductionsMinor += check.deductionsMinor;
    t.netMinor += check.netMinor;
    totals.set(check.currency, t);
  }
  const lead = monthCurrency.toUpperCase();
  const byCurrency = [...totals.values()].sort(
    (a, b) => (a.currency === lead ? 0 : 1) - (b.currency === lead ? 0 : 1) || b.employeeCount - a.employeeCount || a.currency.localeCompare(b.currency),
  );
  const bad = rows.filter((r) => r.check.problems.length).length;
  return { rows, good: rows.length - bad, bad, byCurrency };
}

// ── Reading a sheet ──────────────────────────────────────────────────────────

export type AmountRead = { ok: true; minor: number | null } | { ok: false; reason: string };

const CURRENCY_MARK = /^(?:rs\.?|inr|aed|usd|eur|gbp|₹|\$|€|£|د\.إ)\s*/i;
const CURRENCY_MARK_END = /\s*(?:rs\.?|inr|aed|usd|eur|gbp|₹|\$|€|£|د\.إ)$/i;

/**
 * One amount cell into minor units: a number as Excel holds it, or text as somebody typed it — "45,000", "4,50,000.50"
 * (Indian grouping), "₹45,000", "Rs. 45,000/-", "AED 1,250.75", "(500)" or "-500". A dot is the decimal mark; commas
 * and spaces are grouping. Blank is null (not given); a lone dash is zero. Anything else is a reason, never a guess.
 */
export function parsePayrollAmount(raw: unknown): AmountRead {
  if (raw === null || raw === undefined) return { ok: true, minor: null };
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return { ok: false, reason: `"${raw}" isn't an amount` };
    // Scaled, then cleared of representation noise, then rounded half away from zero (1.005 is 1.01).
    const scaled = Number((raw * 100).toFixed(6));
    return { ok: true, minor: scaled < 0 ? -Math.round(-scaled) : Math.round(scaled) };
  }
  const shown = String(raw).trim();
  if (!shown) return { ok: true, minor: null };
  if (/^[-–—]$/.test(shown)) return { ok: true, minor: 0 };

  let s = shown.replace(/\/-$/, "").trim();
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1).trim(); }
  const sign = () => { if (/^[-−]/.test(s)) { negative = true; s = s.slice(1).trim(); } };
  sign();
  s = s.replace(CURRENCY_MARK, "").replace(CURRENCY_MARK_END, "").trim();
  sign();
  s = s.replace(/[\s,]/g, "");
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(s)) return { ok: false, reason: `"${shown}" isn't an amount` };
  const [whole = "", frac = ""] = s.split(".");
  if (frac.length > 2) return { ok: false, reason: `"${shown}" has more than two decimals` };
  const minor = Number(whole || "0") * 100 + Number(frac.padEnd(2, "0") || "0");
  return { ok: true, minor: negative ? -minor : minor };
}

/** The columns a manual payroll sheet can have, in the template's order, with the headings each is known by. */
export const MANUAL_PAYROLL_FIELDS = [
  { key: "employeeCode", label: "Employee code", required: false, headings: ["employee code", "emp code", "code", "employee id", "emp id", "employee no", "emp no", "employee number", "staff id", "staff code", "id"] },
  { key: "name", label: "Name", required: true, headings: ["name", "employee name", "employee", "full name", "emp name", "staff name"] },
  { key: "departmentName", label: "Department", required: false, headings: ["department", "dept", "department name"] },
  { key: "designation", label: "Designation", required: false, headings: ["designation", "title", "job title", "position", "role"] },
  { key: "currency", label: "Currency", required: false, headings: ["currency", "ccy", "cur"] },
  { key: "bankName", label: "Bank name", required: false, headings: ["bank name", "bank"] },
  { key: "accountNumber", label: "Account number", required: false, headings: ["account number", "account no", "a c no", "ac no", "acc no", "a c number", "bank account", "bank account number", "bank a c no", "account"] },
  { key: "ifsc", label: "IFSC", required: false, headings: ["ifsc", "ifsc code", "ifsc no"] },
  { key: "gross", label: "Gross pay", required: true, headings: ["gross pay", "gross", "gross salary", "gross earnings", "total earnings", "gross amount", "gross wages"] },
  { key: "pf", label: "PF", required: false, headings: ["pf", "provident fund", "epf", "pf deduction", "employee pf"] },
  { key: "esi", label: "ESI", required: false, headings: ["esi", "esic", "esi deduction", "employee esi"] },
  { key: "professionalTax", label: "Professional tax", required: false, headings: ["professional tax", "prof tax", "profession tax", "pt", "p tax"] },
  { key: "tds", label: "TDS (income tax)", required: false, headings: ["tds income tax", "tds", "income tax", "tds it", "it", "tax"] },
  { key: "other", label: "Other deductions", required: false, headings: ["other deductions", "other deduction", "other", "others", "misc deductions"] },
  { key: "net", label: "Net pay", required: false, headings: ["net pay", "net", "net salary", "net payable", "net amount", "take home", "take home pay"] },
] as const;
export type ManualPayrollField = (typeof MANUAL_PAYROLL_FIELDS)[number]["key"];
/** Which column (0-based) each field is read from. A field not in it is not in the file. */
export type ManualPayrollColumns = Partial<Record<ManualPayrollField, number>>;

const normHeading = (h: unknown) => String(h ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** The heading row: the first of the top 30 with both a name and a gross heading. -1 when there is none. */
export function findManualPayrollHeaderRow(rows: unknown[][]): number {
  const name = MANUAL_PAYROLL_FIELDS.find((f) => f.key === "name")!.headings as readonly string[];
  const gross = MANUAL_PAYROLL_FIELDS.find((f) => f.key === "gross")!.headings as readonly string[];
  const limit = Math.min(rows.length, 30);
  for (let i = 0; i < limit; i++) {
    const cells = (rows[i] ?? []).map(normHeading);
    if (cells.some((c) => name.includes(c)) && cells.some((c) => gross.includes(c))) return i;
  }
  return -1;
}

/** Each field's column, by what the headings say — exact headings only, so "Other allowances" is never a deduction. */
export function matchManualPayrollColumns(headings: unknown[]): ManualPayrollColumns {
  const heads = headings.map(normHeading);
  const used = new Set<number>();
  const out: ManualPayrollColumns = {};
  for (const field of MANUAL_PAYROLL_FIELDS) {
    const known = field.headings as readonly string[];
    // The field's first-listed heading wins over a looser one further down the list.
    for (const h of known) {
      const i = heads.findIndex((x, idx) => !used.has(idx) && x === h);
      if (i >= 0) { out[field.key] = i; used.add(i); break; }
    }
  }
  return out;
}

export interface ManualSheetRead {
  /** The rows that could be read, `rowNo` the row in the file (1-based). Checked by `checkManualPayrollRows`. */
  lines: ManualPayrollLine[];
  /** Rows with a cell that isn't an amount: left out, with why. */
  unreadable: Array<{ rowNo: number; name: string; problems: string[] }>;
  /** Blank rows and total rows passed over. */
  skipped: number;
}

const TOTAL_ROW = /^(grand\s*)?totals?\b/i;

/** The body of a sheet, below `headerRow`, read by `columns` into lines. Blank and total rows are passed over. */
export function readManualPayrollRows(rows: unknown[][], headerRow: number, columns: ManualPayrollColumns): ManualSheetRead {
  const lines: ManualPayrollLine[] = [];
  const unreadable: ManualSheetRead["unreadable"] = [];
  let skipped = 0;
  const cell = (r: unknown[], f: ManualPayrollField) => (columns[f] === undefined ? undefined : r[columns[f]!]);
  const text = (r: unknown[], f: ManualPayrollField) => {
    const v = cell(r, f);
    return v === undefined || v === null ? "" : String(v).trim();
  };

  for (let i = headerRow + 1; i < rows.length; i++) {
    const r = rows[i] ?? [];
    const rowNo = i + 1;
    const filled = r.filter((c) => String(c ?? "").trim() !== "");
    if (!filled.length) { skipped++; continue; }
    if (TOTAL_ROW.test(String(filled[0] ?? "").trim())) { skipped++; continue; }

    const problems: string[] = [];
    const money = (f: ManualPayrollField, label: string) => {
      const got = parsePayrollAmount(cell(r, f));
      if (!got.ok) { problems.push(`${label}: ${got.reason}`); return null; }
      return got.minor;
    };
    const gross = money("gross", "Gross pay");
    const pf = money("pf", "PF");
    const esi = money("esi", "ESI");
    const professionalTax = money("professionalTax", "Professional tax");
    const tds = money("tds", "TDS");
    const other = money("other", "Other deductions");
    const net = money("net", "Net pay");
    if (problems.length) {
      unreadable.push({ rowNo, name: text(r, "name"), problems });
      continue;
    }
    const parsed = manualPayrollLineSchema.safeParse({
      rowNo,
      employeeCode: text(r, "employeeCode").slice(0, 40),
      name: text(r, "name").slice(0, 120),
      departmentName: text(r, "departmentName").slice(0, 120),
      designation: text(r, "designation").slice(0, 120),
      currency: text(r, "currency").slice(0, 10),
      bankName: text(r, "bankName").slice(0, 120),
      accountNumber: text(r, "accountNumber").slice(0, 40),
      ifsc: text(r, "ifsc").slice(0, 20),
      grossMinor: gross ?? 0,
      deductions: { pf: pf ?? 0, esi: esi ?? 0, professionalTax: professionalTax ?? 0, tds: tds ?? 0, other: other ?? 0 },
      netMinor: net,
    });
    // Only an amount beyond any payroll (a hundred billion and up) gets here: said, never trimmed to fit.
    if (!parsed.success) { unreadable.push({ rowNo, name: text(r, "name"), problems: ["An amount is too large to be pay"] }); continue; }
    lines.push(parsed.data);
  }
  return { lines, unreadable, skipped };
}

/** The template's example rows (placeholders), in `MANUAL_PAYROLL_FIELDS` order, for a month in `currency`. */
export function manualPayrollTemplateRows(currency: string): string[][] {
  return [
    ["E-001", "Employee One", "Operations", "Executive", currency, "Example Bank", "000123456789", "EXMP0000001", "45,000.00", "1,800.00", "0.00", "200.00", "1,500.00", "0.00", "41,500.00"],
    ["E-002", "Employee Two", "Sales", "Advisor", currency, "Example Bank", "000987654321", "EXMP0000001", "21,000.00", "1,800.00", "157.50", "200.00", "0.00", "500.00", "18,342.50"],
  ];
}
