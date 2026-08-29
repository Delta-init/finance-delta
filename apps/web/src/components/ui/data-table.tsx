"use client";

import { useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
  ChevronLeft,
  ChevronRight,
  Eye,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Checkbox } from "./checkbox";
import { Tooltip } from "./tooltip";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "./dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select";

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  align?: "left" | "right" | "center";
  className?: string;
  /** When true, the header is clickable and emits onSortChange(key). */
  sortable?: boolean;
  /**
   * Keep this column out of the row-detail dialog.
   *
   * Set it on columns that are controls rather than information — a row's
   * action buttons read as an empty field once they are out of the table.
   */
  hideInDetail?: boolean;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[] | undefined;
  getRowId: (row: T) => string;
  total: number;
  page: number; // 1-based
  pageSize: number;
  sort?: { key: string; dir: "asc" | "desc" } | null;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  onSortChange?: (key: string) => void;
  selectable?: boolean;
  onSelectionChange?: (ids: string[]) => void;
  onRowClick?: (row: T) => void;
  isLoading?: boolean;
  emptyMessage?: string;
  pageSizeOptions?: number[];
  /**
   * The per-row "view everything" button, on by default.
   *
   * A table wide enough to scroll hides its right-hand columns, and a cell that
   * truncates hides the rest of its own text — so the row on screen is often
   * not the whole record. This opens the row on its own, every column, nothing
   * cut off. Pass false where a row genuinely has nothing more to show.
   */
  viewable?: boolean;
  /** Heading for that dialog. Falls back to a generic label. */
  detailTitle?: (row: T) => string;
}

const alignClass = (a?: "left" | "right" | "center") =>
  a === "right" ? "text-right" : a === "center" ? "text-center" : "text-left";

export function DataTable<T>({
  columns,
  data,
  getRowId,
  total,
  page,
  pageSize,
  sort,
  onPageChange,
  onPageSizeChange,
  onSortChange,
  selectable = false,
  onSelectionChange,
  onRowClick,
  isLoading = false,
  emptyMessage = "No records found.",
  pageSizeOptions = [10, 25, 50],
  viewable = true,
  detailTitle,
}: DataTableProps<T>) {
  const reduce = useReducedMotion();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [viewing, setViewing] = useState<T | null>(null);
  const rows = data ?? [];
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  const allSelected = rows.length > 0 && rows.every((r) => selected.has(getRowId(r)));
  const someSelected = !allSelected && rows.some((r) => selected.has(getRowId(r)));

  const commit = (next: Set<string>) => {
    setSelected(next);
    onSelectionChange?.([...next]);
  };
  const toggleAll = () => {
    const next = new Set(selected);
    if (allSelected) rows.forEach((r) => next.delete(getRowId(r)));
    else rows.forEach((r) => next.add(getRowId(r)));
    commit(next);
  };
  const toggleRow = (id: string) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    commit(next);
  };

  const colCount = columns.length + (selectable ? 1 : 0) + (viewable ? 1 : 0);
  // Controls are not information; a row's buttons read as an empty field once
  // they are lifted out of the table.
  const detailColumns = columns.filter((c) => !c.hideInDetail && c.header !== "" && c.header != null);

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-primary text-primary-foreground">
              {selectable && (
                <th className="w-12 px-4 py-3.5">
                  <Checkbox
                    variant="onPrimary"
                    checked={allSelected}
                    indeterminate={someSelected}
                    onChange={toggleAll}
                    aria-label="Select all rows"
                  />
                </th>
              )}
              {columns.map((c) => {
                const active = sort?.key === c.key;
                return (
                  <th
                    key={c.key}
                    className={cn(
                      "px-5 py-3.5 text-xs font-semibold uppercase tracking-wider",
                      alignClass(c.align),
                      c.sortable && onSortChange && "cursor-pointer select-none",
                    )}
                    onClick={() => c.sortable && onSortChange?.(c.key)}
                  >
                    <span
                      className={cn(
                        "inline-flex items-center gap-1",
                        c.align === "right" && "flex-row-reverse",
                      )}
                    >
                      {c.header}
                      {c.sortable &&
                        (active ? (
                          sort?.dir === "asc" ? (
                            <ChevronUp className="h-3.5 w-3.5" />
                          ) : (
                            <ChevronDown className="h-3.5 w-3.5" />
                          )
                        ) : (
                          <ChevronsUpDown className="h-3.5 w-3.5 opacity-50" />
                        ))}
                    </span>
                  </th>
                );
              })}
              {viewable && (
                // Pinned, so it stays reachable on a table wide enough to
                // scroll — which is exactly when the eye is most needed.
                <th className="sticky right-0 z-10 w-12 bg-primary px-3 py-3.5" aria-label="View" />
              )}
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={colCount} className="px-5 py-12 text-center text-foreground-muted">
                  Loading…
                </td>
              </tr>
            )}
            {!isLoading && rows.length === 0 && (
              <tr>
                <td colSpan={colCount} className="px-5 py-12 text-center text-foreground-subtle">
                  {emptyMessage}
                </td>
              </tr>
            )}
            {!isLoading && (
              <AnimatePresence initial={false} mode="popLayout">
                {rows.map((row, i) => {
                  const id = getRowId(row);
                  const isSel = selected.has(id);
                  return (
                    <motion.tr
                      key={id}
                      layout={!reduce}
                      initial={reduce ? false : { opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={reduce ? undefined : { opacity: 0 }}
                      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1], delay: reduce ? 0 : i * 0.015 }}
                      className={cn(
                        "border-t border-border transition-colors duration-150",
                        isSel ? "bg-primary-50" : "hover:bg-surface-muted",
                        onRowClick && "cursor-pointer",
                      )}
                      onClick={() => onRowClick?.(row)}
                    >
                      {selectable && (
                        <td className="px-4 py-3.5">
                          <Checkbox checked={isSel} onChange={() => toggleRow(id)} aria-label="Select row" />
                        </td>
                      )}
                      {columns.map((c) => (
                        <td key={c.key} className={cn("px-5 py-3.5 text-foreground", alignClass(c.align), c.className)}>
                          {c.cell(row)}
                        </td>
                      ))}
                      {viewable && (
                        <td
                          className={cn(
                            "sticky right-0 z-10 px-3 py-3.5",
                            // Matches the row so the pinned cell does not show
                            // the columns sliding underneath it.
                            isSel ? "bg-primary-50" : "bg-surface",
                          )}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Tooltip label="View full entry">
                            <button
                              type="button"
                              onClick={() => setViewing(row)}
                              aria-label="View full entry"
                              className="inline-flex h-7 w-7 items-center justify-center rounded text-foreground-muted hover:bg-surface-muted hover:text-foreground"
                            >
                              <Eye className="h-4 w-4" />
                            </button>
                          </Tooltip>
                        </td>
                      )}
                    </motion.tr>
                  );
                })}
              </AnimatePresence>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex flex-col items-center justify-between gap-3 border-t border-border px-4 py-3 text-sm sm:flex-row">
        <div className="flex items-center gap-2 text-foreground-muted">
          <span>Rows per page</span>
          <Select value={String(pageSize)} onValueChange={(v) => onPageSizeChange(Number(v))}>
            <SelectTrigger className="h-8 w-[72px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {pageSizeOptions.map((o) => (
                <SelectItem key={o} value={String(o)}>
                  {o}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-foreground-muted">
            {total === 0 ? "0" : `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)}`} of {total}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => onPageChange(page - 1)}
              disabled={page <= 1}
              aria-label="Previous page"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-foreground-muted transition-colors hover:bg-surface-muted disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            {pageButtons(page, pageCount).map((p, i) =>
              p === "…" ? (
                <span key={`e${i}`} className="px-1.5 text-foreground-subtle">
                  …
                </span>
              ) : (
                <button
                  key={p}
                  onClick={() => onPageChange(p)}
                  className={cn(
                    "inline-flex h-8 min-w-8 items-center justify-center rounded-md px-2 text-sm font-medium transition-colors",
                    p === page
                      ? "bg-primary text-primary-foreground"
                      : "border border-border text-foreground-muted hover:bg-surface-muted",
                  )}
                >
                  {p}
                </button>
              ),
            )}
            <button
              onClick={() => onPageChange(page + 1)}
              disabled={page >= pageCount}
              aria-label="Next page"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-foreground-muted transition-colors hover:bg-surface-muted disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      {/* The row on its own: every column, in full, including the ones the
          table had to scroll away or truncate. */}
      <Dialog open={Boolean(viewing)} onOpenChange={(o) => { if (!o) setViewing(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {viewing && detailTitle ? detailTitle(viewing) : "Entry details"}
            </DialogTitle>
            <DialogDescription>Every field on this row, nothing cut off.</DialogDescription>
          </DialogHeader>

          {viewing && (
            <dl className="divide-y divide-border">
              {detailColumns.map((c) => (
                <div key={c.key} className="flex items-start justify-between gap-6 py-2.5">
                  <dt className="shrink-0 text-xs font-medium uppercase tracking-wide text-foreground-muted">
                    {c.header}
                  </dt>
                  {/* Rendered with the column's own cell, so money, badges and
                      dates look the same here as they do in the table. */}
                  <dd className="min-w-0 break-words text-right text-sm text-foreground">
                    {c.cell(viewing)}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function pageButtons(page: number, pageCount: number): (number | "…")[] {
  const out: (number | "…")[] = [];
  if (pageCount <= 7) {
    for (let i = 1; i <= pageCount; i++) out.push(i);
    return out;
  }
  out.push(1);
  if (page > 3) out.push("…");
  for (let i = Math.max(2, page - 1); i <= Math.min(pageCount - 1, page + 1); i++) out.push(i);
  if (page < pageCount - 2) out.push("…");
  out.push(pageCount);
  return out;
}
