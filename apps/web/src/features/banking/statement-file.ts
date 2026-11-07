import {
  detectDateFormats, detectDecimalStyle, detectDelimiter, detectHeaderRow, looksLikeTotalRow, parseAmount, parseDate, parseDelimited,
  type DecimalStyle, type StatementLineInput,
} from "@delta/shared";

/**
 * A bank statement read in the browser for reconciling (the user, 2026-11-07: "we provide a template, they upload it
 * on the form"): finance's template, or the bank's own export — CSV or Excel — its heading row found and its columns
 * named by what they say, each row read into a line (money in positive, out negative). Rows that can't be read are
 * listed, never guessed.
 */

export const TEMPLATE_HEADINGS = ["Date", "Description", "Reference", "Money out (debit)", "Money in (credit)", "Balance"] as const;
const TEMPLATE_EXAMPLE = [
  ["2026-11-01", "POS purchase — Office supplies", "TXN-10421", "250.00", "", "99750.00"],
  ["2026-11-02", "Transfer from client", "UTR-88123", "", "5000.00", "104750.00"],
];

/** The template, to download: CSV, or Excel with the dates as text so no spreadsheet turns them round. */
export async function downloadTemplate(kind: "csv" | "xlsx") {
  if (kind === "csv") {
    const text = [TEMPLATE_HEADINGS.join(","), ...TEMPLATE_EXAMPLE.map((r) => r.map((c) => (/[,"]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(","))].join("\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: "bank-statement-template.csv" });
    a.click();
    URL.revokeObjectURL(url);
    return;
  }
  const XLSX = await import("xlsx");
  const ws = XLSX.utils.aoa_to_sheet([[...TEMPLATE_HEADINGS], ...TEMPLATE_EXAMPLE]);
  ws["!cols"] = [{ wch: 12 }, { wch: 40 }, { wch: 16 }, { wch: 18 }, { wch: 18 }, { wch: 14 }];
  for (let r = 2; r <= TEMPLATE_EXAMPLE.length + 1; r++) { const c = ws[`A${r}`]; if (c) { c.t = "s"; c.z = "@"; } }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Statement");
  XLSX.writeFile(wb, "bank-statement-template.xlsx");
}

/** The file's rows, as text. */
export async function readStatementRows(file: File): Promise<string[][]> {
  if (/\.(xls|xlsx|xlsm|xlsb|ods)$/i.test(file.name)) {
    const XLSX = await import("xlsx");
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const first = wb.Sheets[wb.SheetNames[0]!];
    if (!first) throw new Error("That workbook has no sheets");
    // As the sheet shows them, so a date reads as it is written and not as a serial number.
    const rows = XLSX.utils.sheet_to_json<string[]>(first, { header: 1, raw: false, defval: "" });
    return rows.map((r) => (r ?? []).map((c) => String(c ?? "")));
  }
  const text = await file.text();
  return parseDelimited(text, detectDelimiter(text));
}

export interface ReadStatement {
  lines: StatementLineInput[];
  /** Rows that couldn't be read, and why — left out of the check. */
  problems: string[];
  /** Which heading each part came from, to say so. */
  columns: Record<"date" | "description" | "reference" | "out" | "in" | "amount" | "balance", string>;
}

const tokens = (h: string) => new Set(h.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
const has = (t: Set<string>, ...any: string[]) => any.some((w) => t.has(w));

/** The statement's lines from its rows: the heading row found, the columns named by what their headings say. */
export function parseStatementRows(rows: string[][]): ReadStatement {
  const shape = detectHeaderRow(rows);
  const hr = shape.headerRow >= 0 ? shape.headerRow : rows.findIndex((r) => r.some((c) => /date/i.test(String(c))));
  if (hr < 0) throw new Error("No heading row found — use the template (Date, Description, Reference, Money out, Money in, Balance)");
  const heads = (rows[hr] ?? []).map((c) => String(c ?? "").trim());
  const t = heads.map(tokens);
  const find = (ok: (x: Set<string>) => boolean, not: number[] = []) => t.findIndex((x, i) => !not.includes(i) && ok(x));
  const date = find((x) => x.has("date"));
  const out = find((x) => has(x, "debit", "debits", "withdrawal", "withdrawals", "dr") || (x.has("out") && has(x, "money", "paid")));
  const inn = find((x) => has(x, "credit", "credits", "deposit", "deposits", "cr") || (x.has("in") && has(x, "money", "paid")), [out]);
  const amount = out < 0 && inn < 0 ? find((x) => x.has("amount")) : -1;
  const balance = find((x) => x.has("balance"), [out, inn, amount]);
  const description = find((x) => has(x, "description", "particulars", "particular", "narration", "details", "detail", "remarks", "remark"), [date]);
  const reference = find((x) => has(x, "reference", "ref", "cheque", "chq", "utr", "txn") || (x.has("transaction") && !x.has("date")), [date, description, out, inn, amount, balance]);
  if (date < 0) throw new Error("No Date column found");
  if (out < 0 && inn < 0 && amount < 0) throw new Error("No amount columns found — Money out and Money in, or Amount");

  // Each with its row number in the file, for saying which row could not be read.
  const body = rows.map((r, i) => Object.assign([...r], { rowNo: i + 1 })).slice(hr + 1)
    .filter((r) => r.some((c) => String(c ?? "").trim()) && !looksLikeTotalRow(r.map((c) => String(c ?? ""))));
  const cell = (r: string[], i: number) => (i >= 0 ? String(r[i] ?? "").trim() : "");
  const formats = detectDateFormats(body.map((r) => cell(r, date)).filter(Boolean));
  const format = formats[0] ?? "ymd";
  const samples = body.flatMap((r) => [cell(r, out), cell(r, inn), cell(r, amount), cell(r, balance)]).filter(Boolean);
  const detected = detectDecimalStyle(samples);
  const style: DecimalStyle = detected === "ambiguous" ? "dot" : detected;
  const money = (raw: string) => (raw ? parseAmount(raw, style) : { ok: true, minor: 0 });

  const lines: StatementLineInput[] = [];
  const problems: string[] = [];
  body.forEach((r) => {
    const rowNo = r.rowNo;
    const d = parseDate(cell(r, date), format);
    if (!d.ok) { problems.push(`Row ${rowNo}: ${d.reason ?? "the date can't be read"}`); return; }
    let minor = 0;
    if (amount >= 0) {
      const a = money(cell(r, amount));
      if (!a.ok) { problems.push(`Row ${rowNo}: ${a.reason ?? "the amount can't be read"}`); return; }
      minor = a.minor;
    } else {
      const o = money(cell(r, out)), i = money(cell(r, inn));
      if (!o.ok || !i.ok) { problems.push(`Row ${rowNo}: ${(!o.ok ? o.reason : i.reason) ?? "an amount can't be read"}`); return; }
      minor = Math.abs(i.minor) - Math.abs(o.minor);
    }
    if (!minor) return; // a balance-only row
    const b = cell(r, balance) ? parseAmount(cell(r, balance), style) : null;
    lines.push({
      date: d.iso, description: cell(r, description).slice(0, 300), reference: cell(r, reference).slice(0, 120), amountMinor: minor,
      balanceMinor: b && b.ok ? b.minor : null,
    });
  });
  const name = (i: number) => (i >= 0 ? heads[i] || `column ${i + 1}` : "");
  return { lines, problems, columns: { date: name(date), description: name(description), reference: name(reference), out: name(out), in: name(inn), amount: name(amount), balance: name(balance) } };
}
