import * as XLSX from "xlsx";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { api, type QueryParams } from "@/lib/api";

export interface ExportColumn<T> {
  header: string;
  /** Cell value. Return a number for numeric Excel cells (e.g. amounts), else a string. */
  value: (row: T) => string | number;
}

const EXPORT_PAGE_SIZE = 100; // server caps pageSize at 100
const MAX_PAGES = 1000; // runaway guard

/**
 * Fetch every row matching the given filters, ignoring UI pagination.
 * `params` are the list's current filters; page/pageSize are overridden here.
 */
export async function fetchAllRows<T>(resource: string, params: QueryParams = {}): Promise<T[]> {
  const rows: T[] = [];
  let page = 1;
  while (page <= MAX_PAGES) {
    const { data, meta } = await api.getList<T>(resource, { ...params, page, pageSize: EXPORT_PAGE_SIZE });
    rows.push(...data);
    const pageCount = meta.pageCount ?? 1;
    if (page >= pageCount || data.length === 0) break;
    page += 1;
  }
  return rows;
}

function matrix<T>(columns: ExportColumn<T>[], rows: T[]) {
  const headers = columns.map((c) => c.header);
  const body = rows.map((r) => columns.map((c) => c.value(r)));
  return { headers, body };
}

export function exportToExcel<T>(filename: string, sheetTitle: string, columns: ExportColumn<T>[], rows: T[]): void {
  const { headers, body } = matrix(columns, rows);
  const ws = XLSX.utils.aoa_to_sheet([headers, ...body]);
  // Reasonable column widths based on header length.
  ws["!cols"] = headers.map((h) => ({ wch: Math.max(12, Math.min(40, h.length + 4)) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetTitle.slice(0, 31) || "Export");
  XLSX.writeFile(wb, filename.endsWith(".xlsx") ? filename : `${filename}.xlsx`);
}

export function exportToPdf<T>(title: string, filename: string, columns: ExportColumn<T>[], rows: T[]): void {
  const { headers, body } = matrix(columns, rows);
  const doc = new jsPDF({ orientation: columns.length > 6 ? "landscape" : "portrait" });
  const generatedOn = new Date().toISOString().slice(0, 10);
  doc.setFontSize(14);
  doc.text(title, 14, 16);
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text(`${rows.length} record${rows.length === 1 ? "" : "s"} · ${generatedOn}`, 14, 22);
  autoTable(doc, {
    head: [headers],
    body: body.map((r) => r.map((c) => (c === null || c === undefined ? "" : String(c)))),
    startY: 26,
    styles: { fontSize: 8, cellPadding: 2, overflow: "linebreak" },
    headStyles: { fillColor: [37, 99, 235], textColor: 255, fontStyle: "bold" },
    alternateRowStyles: { fillColor: [246, 248, 251] },
  });
  doc.save(filename.endsWith(".pdf") ? filename : `${filename}.pdf`);
}
