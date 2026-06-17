"use client";

import { useEffect, useMemo, useState } from "react";
import { useDebounced } from "@/hooks/use-debounced";
import type { QueryParams } from "@/lib/api";

export interface SortState {
  key: string;
  dir: "asc" | "desc";
}

/**
 * Standard server-side list state: page, pageSize, sort, debounced search.
 * Managers merge their own filters into `baseParams` and call `resetPage()`
 * when those filters change.
 */
export function useTableQuery(opts?: { initialSort?: SortState; initialPageSize?: number }) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeState] = useState(opts?.initialPageSize ?? 10);
  const [sort, setSort] = useState<SortState | null>(opts?.initialSort ?? null);
  const [q, setQ] = useState("");
  const debouncedQ = useDebounced(q, 300);

  useEffect(() => {
    setPage(1);
  }, [debouncedQ]);

  const handleSort = (key: string) => {
    setSort((p) => (p?.key === key ? { key, dir: p.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));
    setPage(1);
  };

  const setPageSize = (s: number) => {
    setPageSizeState(s);
    setPage(1);
  };

  const baseParams: QueryParams = useMemo(
    () => ({
      page,
      pageSize,
      sort: sort?.key,
      dir: sort?.dir,
      q: debouncedQ || undefined,
    }),
    [page, pageSize, sort, debouncedQ],
  );

  return {
    page,
    pageSize,
    sort,
    q,
    setQ,
    setPage,
    setPageSize,
    handleSort,
    baseParams,
    resetPage: () => setPage(1),
  };
}
