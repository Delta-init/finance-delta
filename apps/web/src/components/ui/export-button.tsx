"use client";

import { useState } from "react";
import { Download, FileSpreadsheet, FileText, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ApiError, type QueryParams } from "@/lib/api";
import { toast } from "@/lib/toast";
import { fetchAllRows, exportToExcel, exportToPdf, type ExportColumn } from "@/lib/export";

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
}

export function ExportButton<T>({ resource, params, columns, filename, title, disabled, size = "sm" }: ExportButtonProps<T>) {
  const [busy, setBusy] = useState<null | "excel" | "pdf">(null);
  const [open, setOpen] = useState(false);

  async function run(kind: "excel" | "pdf") {
    setBusy(kind);
    try {
      const rows = await fetchAllRows<T>(resource, params);
      if (rows.length === 0) {
        toast.error("Nothing to export for the current filters");
        return;
      }
      if (kind === "excel") exportToExcel(filename, title, columns, rows);
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
          <button
            type="button"
            disabled={anyBusy}
            onClick={() => run("excel")}
            className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-surface-muted disabled:opacity-50"
          >
            {busy === "excel" ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4 text-success" />}
            Excel (.xlsx)
          </button>
          <button
            type="button"
            disabled={anyBusy}
            onClick={() => run("pdf")}
            className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-surface-muted disabled:opacity-50"
          >
            {busy === "pdf" ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4 text-danger" />}
            PDF
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
