/**
 * Bank statement parsing.
 *
 * Pure functions, deliberately shared: the import wizard parses in the browser
 * so the preview updates as you change the column mapping, and the API parses
 * again on the way in so a hand-made request cannot post a date or an amount
 * the wizard would have rejected. Two parsers that disagree would be worse than
 * either, so there is only one.
 *
 * Every function here reports failure rather than guessing. A statement import
 * that silently turns a debit into a credit is not caught until somebody
 * reconciles three months later, so "I could not read this" is always the
 * better answer than a plausible number.
 */

// ── Amounts ───────────────────────────────────────────────────────────────────

/**
 * Which way round a statement writes thousands and decimals.
 *
 * `1.234,56` and `1,234.56` are the same amount written by different banks, and
 * reading one as the other is out by a factor of a thousand. There is no
 * reliable way to tell from a single value — `1.234` is either — so the format
 * is detected across the whole column, and asked about when it stays ambiguous.
 */
export type DecimalStyle = "dot" | "comma";

export interface AmountParse {
  ok: boolean;
  minor: number;
  /** Why it could not be read. Shown against the row in the preview. */
  reason?: string;
}

/** Trailing or leading debit/credit markers, e.g. `500.00 DR`, `CR 500`. */
const DEBIT_MARK = /(^|\s)(dr|debit|db|withdrawal)\.?(\s|$)/i;
const CREDIT_MARK = /(^|\s)(cr|credit)\.?(\s|$)/i;

/**
 * Read one amount cell into integer minor units.
 *
 * Handles what real statements actually contain: thousands separators in either
 * convention, currency symbols and codes, `DR`/`CR` markers, and parenthesised
 * negatives. `(500.00)` is a debit in every accounting convention there is —
 * the old parser stripped the brackets and imported it as a credit.
 */
export function parseAmount(raw: string, style: DecimalStyle = "dot"): AmountParse {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { ok: true, minor: 0 };

  // A lone dash is how most statements write "nothing in this column".
  if (/^[-–—]$/.test(trimmed)) return { ok: true, minor: 0 };

  let negative = false;

  // Brackets mean negative, and must be read before they are stripped.
  let body = trimmed;
  if (/^\(.*\)$/.test(body)) {
    negative = true;
    body = body.slice(1, -1);
  }

  if (DEBIT_MARK.test(body)) negative = true;
  else if (CREDIT_MARK.test(body)) negative = false;
  body = body.replace(DEBIT_MARK, " ").replace(CREDIT_MARK, " ");

  if (/^\s*-/.test(body)) negative = true;

  // Everything that is not a digit or a separator: currency symbols, codes,
  // spaces used as thousands separators, and the sign we have already read.
  body = body.replace(/[^\d.,]/g, "");
  if (!body) return { ok: false, minor: 0, reason: `No number in "${trimmed}"` };

  // Collapse the separators according to the column's convention. The decimal
  // separator is the last one of its kind; everything else is thousands.
  const decimalSep = style === "comma" ? "," : ".";
  const thousandsSep = style === "comma" ? "." : ",";
  body = body.split(thousandsSep).join("");
  const parts = body.split(decimalSep);
  if (parts.length > 2) {
    return { ok: false, minor: 0, reason: `Cannot read "${trimmed}" as a number` };
  }
  const whole = parts[0] ?? "";
  const frac = parts[1] ?? "";
  if (frac.length > 2) {
    // Three digits after the separator almost always means the separator was a
    // thousands mark and the column convention is the other way round.
    return {
      ok: false,
      minor: 0,
      reason: `"${trimmed}" has ${frac.length} decimal places — is the number format right?`,
    };
  }
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(frac)) {
    return { ok: false, minor: 0, reason: `Cannot read "${trimmed}" as a number` };
  }
  if (!whole && !frac) return { ok: false, minor: 0, reason: `No number in "${trimmed}"` };

  // Built from the digits rather than by multiplying a float: 1.005 * 100 is
  // 100.49999999999999 in binary floating point, which rounds to the wrong
  // fils. Padding the fraction avoids arithmetic on a non-integer entirely.
  const minor = Number(whole || "0") * 100 + Number(frac.padEnd(2, "0") || "0");
  return { ok: true, minor: negative ? -minor : minor };
}

/**
 * Work out which convention a column of amounts is written in.
 *
 * Decided over the whole column because a single value rarely settles it. Only
 * a separator followed by exactly three digits, with no other separator after
 * it, is proof of a thousands mark.
 */
export function detectDecimalStyle(samples: string[]): DecimalStyle | "ambiguous" {
  let dotEvidence = 0;
  let commaEvidence = 0;

  for (const s of samples) {
    const v = (s ?? "").trim();
    if (!v) continue;
    // Two of the same separator can only be thousands marks.
    if ((v.match(/\./g) ?? []).length > 1) commaEvidence++;
    if ((v.match(/,/g) ?? []).length > 1) dotEvidence++;
    // Both present: whichever comes last is the decimal separator.
    const lastDot = v.lastIndexOf(".");
    const lastComma = v.lastIndexOf(",");
    if (lastDot >= 0 && lastComma >= 0) {
      if (lastDot > lastComma) dotEvidence++;
      else commaEvidence++;
      continue;
    }
    // One separator with exactly three digits after it, e.g. 1.234 — a
    // thousands mark. Two digits would be a decimal, and proves nothing either
    // way, so it is not counted.
    if (lastDot >= 0 && v.length - lastDot - 1 === 3) commaEvidence++;
    if (lastComma >= 0 && v.length - lastComma - 1 === 3) dotEvidence++;
  }

  if (dotEvidence > commaEvidence) return "dot";
  if (commaEvidence > dotEvidence) return "comma";
  return "ambiguous";
}

// ── Dates ─────────────────────────────────────────────────────────────────────

/**
 * The layouts banks actually use. Deliberately explicit rather than handing the
 * string to `new Date()`, which reads `15/01/2026` as invalid and `01/02/2026`
 * as the wrong month without complaining.
 */
export type DateFormat = "dmy" | "mdy" | "ymd" | "dMonY";

export const DATE_FORMAT_LABELS: Record<DateFormat, string> = {
  dmy: "Day/Month/Year (15/01/2026)",
  mdy: "Month/Day/Year (01/15/2026)",
  ymd: "Year-Month-Day (2026-01-15)",
  dMonY: "Day-Mon-Year (15-Jan-2026)",
};

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

export interface DateParse {
  ok: boolean;
  /** `YYYY-MM-DD`. No time and no zone: a statement date is a calendar day, and
   *  attaching a zone to it is how an import lands on the previous day. */
  iso: string;
  reason?: string;
}

function build(y: number, m: number, d: number, raw: string): DateParse {
  if (m < 1 || m > 12) return { ok: false, iso: "", reason: `"${raw}" has no month ${m}` };
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d < 1 || d > daysInMonth) {
    return { ok: false, iso: "", reason: `"${raw}" is not a real date` };
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return { ok: true, iso: `${y}-${pad(m)}-${pad(d)}` };
}

/** Read one date cell in a known layout. Never guesses. */
export function parseDate(raw: string, format: DateFormat): DateParse {
  const v = (raw ?? "").trim();
  if (!v) return { ok: false, iso: "", reason: "Empty date" };

  if (format === "dMonY") {
    const m = v.match(/^(\d{1,2})[\s\-/]*([A-Za-z]{3,4})[\s\-/]*(\d{2,4})$/);
    if (!m) return { ok: false, iso: "", reason: `"${v}" is not a Day-Mon-Year date` };
    const month = MONTHS[m[2]!.toLowerCase()];
    if (!month) return { ok: false, iso: "", reason: `"${m[2]}" is not a month` };
    return build(expandYear(Number(m[3])), month, Number(m[1]), v);
  }

  const m = v.match(/^(\d{1,4})[-/.\s](\d{1,2})[-/.\s](\d{1,4})$/);
  if (!m) return { ok: false, iso: "", reason: `"${v}" is not a date` };
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];

  if (format === "ymd") return build(expandYear(a), b, c, v);
  if (format === "dmy") return build(expandYear(c), b, a, v);
  return build(expandYear(c), a, b, v);
}

/** Two-digit years. Statements are not from the 1920s. */
function expandYear(y: number): number {
  if (y >= 1000) return y;
  return y < 70 ? 2000 + y : 1900 + y;
}

/**
 * Narrow a column of dates to the layouts that can read every value in it.
 *
 * Returns every candidate rather than picking one. A column where each day is
 * twelve or under is genuinely both `dmy` and `mdy`, and the difference is
 * March against April — that has to be a question, not a guess.
 */
export function detectDateFormats(samples: string[]): DateFormat[] {
  const values = samples.map((s) => (s ?? "").trim()).filter(Boolean);
  if (values.length === 0) return [];
  const formats: DateFormat[] = ["ymd", "dmy", "mdy", "dMonY"];
  return formats.filter((f) => values.every((v) => parseDate(v, f).ok));
}

// ── CSV ───────────────────────────────────────────────────────────────────────

/**
 * A CSV reader that respects quoting.
 *
 * Splitting on newlines before honouring quotes breaks on any statement with a
 * line break inside a description field — and rather than failing, it shifts
 * every column after it, so the amount is read out of the wrong cell.
 */
export function parseDelimited(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let quoted = false;

  // A leading byte-order mark otherwise becomes part of the first header, and
  // the column never matches by name again.
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cur += '"'; i++; }  // "" is one literal quote
        else quoted = false;
      } else cur += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === delimiter) { row.push(cur.trim()); cur = ""; continue; }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cur.trim());
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
      cur = "";
      continue;
    }
    cur += ch;
  }
  row.push(cur.trim());
  if (row.some((c) => c !== "")) rows.push(row);
  return rows;
}

/** Guess the delimiter from the header line. Some banks export semicolons. */
export function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const counts = [",", ";", "\t", "|"].map(
    (d) => [d, (firstLine.match(new RegExp(`\\${d}`, "g")) ?? []).length] as const,
  );
  const best = counts.reduce((a, b) => (b[1] > a[1] ? b : a));
  return best[1] > 0 ? best[0] : ",";
}

// ── Duplicates ────────────────────────────────────────────────────────────────

/**
 * Identity of a statement line, for spotting a statement imported twice.
 *
 * Description is squashed to letters and digits because the same transaction
 * comes back with different spacing and punctuation between exports. Date,
 * amount and reference are what genuinely identify it.
 *
 * Two different transactions can legitimately share a fingerprint — a shop
 * visited twice in a day for the same amount — which is why a match is
 * surfaced for a decision rather than dropped.
 */
export function fingerprint(input: {
  isoDate: string;
  amountMinor: number;
  description: string;
  reference?: string;
}): string {
  const norm = (s: string) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return [
    input.isoDate,
    String(input.amountMinor),
    norm(input.description),
    norm(input.reference ?? ""),
  ].join("|");
}

// ── Sheet shape ───────────────────────────────────────────────────────────────

/**
 * Words that appear in a statement's column headings.
 *
 * Used to find the heading row, not to name the columns — a bank that writes
 * "Narration" instead of "Particulars" should still be recognisable as having
 * a heading row there.
 */
const HEADER_WORDS = [
  "date", "particular", "narration", "description", "detail", "remark",
  "withdrawal", "deposit", "debit", "credit", "amount", "balance",
  "reference", "cheque", "chq", "tran", "transaction", "value",
];

export interface SheetShape {
  /** Index of the heading row within the rows given. `-1` when none was found. */
  headerRow: number;
  /** Rows above the heading — account number, opening balance and the like. */
  metadataRows: number;
}

/**
 * Find the heading row in a sheet that does not start with one.
 *
 * Bank exports open with a block of account details, so the headings are
 * often twenty rows down. The heading row is the one matching the most known
 * heading words; ties go to the earliest, and a row needs at least three
 * matches to count, so a metadata line mentioning "Date of Issue" cannot win.
 */
export function detectHeaderRow(rows: string[][]): SheetShape {
  let best = -1;
  let bestScore = 2; // a row must beat this, so two stray matches are not enough

  // Only the top of a sheet is worth searching: a heading row further down
  // than this is a second statement in one file, which is not a shape to guess.
  const limit = Math.min(rows.length, 40);
  for (let i = 0; i < limit; i++) {
    const cells = (rows[i] ?? []).map((c) => String(c ?? "").toLowerCase().trim());
    const score = HEADER_WORDS.filter((w) => cells.some((c) => c.includes(w))).length;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return { headerRow: best, metadataRows: best < 0 ? 0 : best };
}

/**
 * Column headings paired with the position they sit at.
 *
 * Position is what identifies a column, because heading text does not: a real
 * statement had eighteen unnamed columns out of twenty-eight, and every one of
 * them matched the first by name.
 */
export interface ColumnRef {
  index: number;
  /** Heading text, or a positional stand-in where the heading is blank. */
  label: string;
  /** True when the heading was blank and the label was made up. */
  unnamed: boolean;
}

export function columnRefs(headerCells: string[]): ColumnRef[] {
  return headerCells.map((raw, index) => {
    const label = String(raw ?? "").trim();
    return label
      ? { index, label, unnamed: false }
      : { index, label: `Column ${index + 1}`, unnamed: true };
  });
}

/**
 * Drop columns that hold nothing anywhere.
 *
 * Bank sheets pad heavily — a statement with ten real columns arrived as
 * twenty-eight. Offering the empty ones in the mapping dropdowns buries the
 * ones that matter.
 */
export function usefulColumns(refs: ColumnRef[], rows: string[][]): ColumnRef[] {
  return refs.filter(
    (c) => !c.unnamed || rows.some((r) => String(r[c.index] ?? "").trim() !== ""),
  );
}

/**
 * Rows that are a total or a note rather than a transaction.
 *
 * A statement ends with a totals line and a page of small print, and both sit
 * in the same columns as the transactions above them.
 */
const NOT_A_TRANSACTION = /^(grand\s*total|total|opening\s*balance|closing\s*balance|carried\s*forward|brought\s*forward|b\/f|c\/f|\*+\s*end)/i;

export function looksLikeTotalRow(cells: string[]): boolean {
  return cells.some((c) => NOT_A_TRANSACTION.test(String(c ?? "").trim()));
}

// ── Statement metadata ────────────────────────────────────────────────────────

/**
 * Details a bank prints above the transactions.
 *
 * Read so the import can check it is going into the right account and that the
 * arithmetic lands where the bank says it should. Everything is optional: this
 * is a convenience read off an unstructured block, and nothing depends on it.
 */
export interface StatementMeta {
  accountNumber?: string;
  openingBalanceMinor?: number;
  closingBalanceMinor?: number;
}

/**
 * Pull what can be recognised from the block above the headings.
 *
 * Labels are matched loosely because banks pad them with spaces and colons,
 * and the value is taken from the next non-empty cell on the same row — which
 * is how these sheets are laid out.
 */
export function readStatementMeta(metaRows: string[][], style: DecimalStyle = "dot"): StatementMeta {
  const meta: StatementMeta = {};

  const valueAfter = (row: string[], from: number): string => {
    for (let j = from + 1; j < row.length; j++) {
      const v = String(row[j] ?? "").trim();
      if (v) return v;
    }
    return "";
  };

  for (const row of metaRows) {
    for (let i = 0; i < row.length; i++) {
      const label = String(row[i] ?? "").toLowerCase().replace(/[\s:]+/g, " ").trim();
      if (!label) continue;

      if (!meta.accountNumber && /^account number\b/.test(label)) {
        const v = valueAfter(row, i).replace(/\s/g, "");
        if (/^\d{6,}$/.test(v)) meta.accountNumber = v;
      }
      if (meta.openingBalanceMinor === undefined && /^opening balance\b/.test(label)) {
        const p = parseAmount(valueAfter(row, i), style);
        if (p.ok) meta.openingBalanceMinor = p.minor;
      }
      // "Effective Available Balance" is the balance as at the statement date,
      // which is the closing figure for what the file covers.
      if (
        meta.closingBalanceMinor === undefined &&
        /^(closing balance|effective available balance)\b/.test(label)
      ) {
        const p = parseAmount(valueAfter(row, i), style);
        if (p.ok) meta.closingBalanceMinor = p.minor;
      }
    }
  }
  return meta;
}

/**
 * Check the arithmetic against the bank's own running balance.
 *
 * The strongest check available on an import: the bank states a balance after
 * every line, so a mapping that reads the wrong column, or a missed row, shows
 * up as a mismatch rather than as a plausible ledger.
 */
export function verifyBalances(
  openingMinor: number,
  lines: { amountMinor: number; statedBalanceMinor?: number }[],
): { ok: boolean; firstMismatchAt: number; expectedMinor: number; statedMinor: number } {
  let running = openingMinor;
  for (let i = 0; i < lines.length; i++) {
    running += lines[i]!.amountMinor;
    const stated = lines[i]!.statedBalanceMinor;
    if (stated !== undefined && stated !== running) {
      return { ok: false, firstMismatchAt: i, expectedMinor: running, statedMinor: stated };
    }
  }
  return { ok: true, firstMismatchAt: -1, expectedMinor: running, statedMinor: running };
}
