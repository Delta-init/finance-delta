"use client";

import { useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Checkbox } from "./checkbox";
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
}: DataTableProps<T>) {
  const reduce = useReducedMotion();
  const [selected, setSelected] = useState<Set<string>>(new Set());
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

  const colCount = columns.length + (selectable ? 1 : 0);

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
