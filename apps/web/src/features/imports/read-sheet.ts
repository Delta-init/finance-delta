import { detectDelimiter, parseDelimited, type ImportField } from "@delta/shared";

/** What the import takes: CSV (and other delimited text) and Excel. */
export const IMPORT_ACCEPT = ".csv,.txt,.tsv,.xls,.xlsx,.xlsm,.ods";

/** One row of the sheet, with its row number there — what every message about it names. */
export interface SheetRow {
  n: number;
  cells: string[];
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A number as plain text: 1234.5, never 1.2345e3 or 0.30000000000000004. */
function numberText(v: number): string {
  if (!Number.isFinite(v)) return "";
  return Number.isInteger(v) ? String(v) : String(parseFloat(v.toFixed(6)));
}

/**
 * One Excel cell as text. A real date cell becomes 2026-01-15 from its serial number — never through the sheet's own
 * formatting, which for Excel's built-in short date is US month/day (SheetJS writes 15 January as 1/15/26, and 3 January
 * as 1/3/26, read back as 1 March). A percent cell keeps its % (5%, not 0.05); other numbers are plain.
 */
function cellText(XLSX: any, cell: any, date1904: boolean): string {
  if (!cell) return "";
  if (cell.t === "n") {
    const fmt = typeof cell.z === "string" ? cell.z : "";
    if (fmt && XLSX.SSF.is_date(fmt)) {
      const p = XLSX.SSF.parse_date_code(cell.v, { date1904 });
      if (p && p.y) return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
    }
    if (typeof cell.w === "string" && cell.w.trim().endsWith("%")) return cell.w.trim();
    return numberText(Number(cell.v));
  }
  if (cell.t === "d" && cell.v instanceof Date) {
    const d = cell.v as Date;
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  if (cell.t === "b") return cell.v ? "TRUE" : "FALSE";
  if (cell.t === "e" || cell.t === "z") return "";
  return String(cell.v ?? cell.w ?? "").trim();
}

/**
 * The first sheet of a workbook, or a delimited text file, as rows of text. Empty rows are left out; each row keeps its
 * number in the sheet. Loaded on demand: the Excel reader is large and most of the app never needs it.
 */
export async function readSheet(file: File): Promise<SheetRow[]> {
  if (/\.(xls|xlsx|xlsm|xlsb|ods)$/i.test(file.name)) {
    const XLSX: any = await import("xlsx");
    // cellDates off and the number formats kept, so date cells can be read from their serial numbers exactly.
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: false, cellNF: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws || !ws["!ref"]) return [];
    const date1904 = Boolean(wb.Workbook?.WBProps?.date1904);
    const range = XLSX.utils.decode_range(ws["!ref"]);
    const rows: SheetRow[] = [];
    for (let r = range.s.r; r <= range.e.r; r++) {
      const cells: string[] = [];
      for (let c = range.s.c; c <= range.e.c; c++) cells.push(cellText(XLSX, ws[XLSX.utils.encode_cell({ r, c })], date1904));
      if (cells.some((c) => c !== "")) rows.push({ n: r + 1, cells });
    }
    return rows;
  }
  // Text: read here, not by the Excel reader, which would take 03/04/2026 as 4 March.
  const text = await file.text();
  return parseDelimited(text, detectDelimiter(text)).map((cells, i) => ({ n: i + 1, cells }));
}

/**
 * The template: the columns' headings, nothing under them (an example row would be imported if left in). The Excel
 * one has a second sheet saying what goes in each column, with an example.
 */
export async function downloadTemplate(fields: readonly ImportField[], name: string, kind: "xlsx" | "csv"): Promise<void> {
  const headings = fields.map((f) => f.label);
  if (kind === "csv") {
    const line = headings.map((h) => (/[",\n]/.test(h) ? `"${h.replace(/"/g, '""')}"` : h)).join(",");
    const blob = new Blob([`﻿${line}\r\n`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return;
  }
  const XLSX = await import("xlsx");
  const sheet = XLSX.utils.aoa_to_sheet([headings]);
  sheet["!cols"] = headings.map((h) => ({ wch: Math.max(14, h.length + 4) }));
  const help = XLSX.utils.aoa_to_sheet([
    ["Column", "Required", "What goes in it", "Example"],
    ...fields.map((f) => [f.label, f.required ? "Yes" : f.hint?.startsWith("Needed when") ? "Sometimes" : "No", f.hint ?? "", f.example]),
    [],
    ["Dates: 15/01/2026 (day first), 2026-01-15, 15-Jan-2026, or real Excel dates. Month-first files can be switched on the Match step."],
    ["Amounts: plain numbers, e.g. 1050.00 or 1,050.00. At most 1,000 rows per file."],
  ]);
  help["!cols"] = [{ wch: 16 }, { wch: 10 }, { wch: 60 }, { wch: 28 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, "Import");
  XLSX.utils.book_append_sheet(wb, help, "How to fill");
  XLSX.writeFile(wb, `${name}.xlsx`);
}
