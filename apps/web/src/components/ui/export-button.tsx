"use client";

import { useState, type ReactNode } from "react";
import { Download, FileSpreadsheet, FileText, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ApiError, type QueryParams } from "@/lib/api";
import { toast } from "@/lib/toast";
import { fetchAllRows, exportToCsv, exportToExcel, exportToPdf, type ExportColumn } from "@/lib/export";

type ExportFormat = "csv" | "excel" | "pdf";

const FORMATS: Record<ExportFormat, { label: string; icon: ReactNode }> = {
  csv: { label: "CSV (.csv)", icon: <FileSpreadsheet className="h-4 w-4 text-primary" /> },
  excel: { label: "Excel (.xlsx)", icon: <FileSpreadsheet className="h-4 w-4 text-success" /> },
  pdf: { label: "PDF", icon: <FileText className="h-4 w-4 text-danger" /> },
};

interface ExportButtonProps<T> {
  /** API list resource path, e.g. "invoices". */
  resource: string;
  /** Current list filters (page/pageSize are overridden — the full filtered set is exported). */
  params?: QueryParams;
  columns: ExportColumn<T>[];
  /** Base file name (without extension), e.g. "invoices". */
  filename: string;
  /** Human title used in the PDF header and Excel sheet name. */
  title: string;
  disabled?: boolean;
  size?: "sm" | "md";
  /** The files it offers, in this order. Excel and PDF unless a page asks for others. */
  formats?: ExportFormat[];
}

export function ExportButton<T>({ resource, params, columns, filename, title, disabled, size = "sm", formats = ["excel", "pdf"] }: ExportButtonProps<T>) {
  const [busy, setBusy] = useState<null | ExportFormat>(null);
  const [open, setOpen] = useState(false);

  async function run(kind: ExportFormat) {
    setBusy(kind);
    try {
      const rows = await fetchAllRows<T>(resource, params);
      if (rows.length === 0) {
        toast.error("Nothing to export for the current filters");
        return;
      }
      if (kind === "excel") exportToExcel(filename, title, columns, rows);
      else if (kind === "csv") exportToCsv(filename, columns, rows);
      else exportToPdf(title, filename, columns, rows);
      toast.success(`Exported ${rows.length} record${rows.length === 1 ? "" : "s"}`);
      setOpen(false);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Export failed");
    } finally {
      setBusy(null);
    }
  }

  const anyBusy = busy !== null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size={size} disabled={disabled || anyBusy}>
          {anyBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Export
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56">
        <div className="space-y-1">
          <p className="px-2 pb-1 text-xs font-medium text-foreground-muted">
            Export all filtered rows
          </p>
          {formats.map((format) => (
            <button
              key={format}
              type="button"
              disabled={anyBusy}
              onClick={() => run(format)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-surface-muted disabled:opacity-50"
            >
              {busy === format ? <Loader2 className="h-4 w-4 animate-spin" /> : FORMATS[format].icon}
              {FORMATS[format].label}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
