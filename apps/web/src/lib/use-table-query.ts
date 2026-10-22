"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "next/navigation";
import type { QueryParams } from "@/lib/api";
import { useUrlText, writeQuery } from "@/lib/url-state";

export interface SortState {
  key: string;
  dir: "asc" | "desc";
}

/**
 * Standard server-side list state: page, pageSize, sort, debounced search.
 * Managers merge their own filters into `baseParams`; a filter kept with
 * lib/url-state's hooks goes back to page 1 by itself, and `resetPage()` does
 * it for one kept anywhere else.
 *
 * Kept in the address bar since 2026-10-22 (page, size, sort, dir, q — the
 * defaults left out), so a refresh or coming back from a record lands on the
 * same page of the same list. A second table on a page keeps its own under a
 * `prefix` ("queue_page", …).
 */
export function useTableQuery(opts?: { initialSort?: SortState; initialPageSize?: number; prefix?: string }) {
  const k = (name: string) => (opts?.prefix ? `${opts.prefix}_${name}` : name);
  const search = useSearchParams();
  const defaultSize = opts?.initialPageSize ?? 10;
  const page = Math.max(1, Math.floor(Number(search.get(k("page")))) || 1);
  const pageSize = Number(search.get(k("size"))) || defaultSize;
  const sortKey = search.get(k("sort"));
  const sortDir = search.get(k("dir")) === "desc" ? "desc" : "asc";
  const initialSort = opts?.initialSort;
  const sort: SortState | null = useMemo(
    () => (sortKey ? { key: sortKey, dir: sortDir } : initialSort ?? null),
    [sortKey, sortDir, initialSort?.key, initialSort?.dir], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const [q, setQ, applied] = useUrlText(k("q"), { page: k("page") });

  // A page's own "back to page 1" effects run as it mounts — not then, or the page in the address would be lost.
  const ready = useRef(false);
  useEffect(() => {
    const id = setTimeout(() => { ready.current = true; }, 0);
    return () => clearTimeout(id);
  }, []);

  const pageKey = k("page"), sizeKey = k("size"), sortKeyName = k("sort"), dirKey = k("dir");
  const setPage = useCallback((p: number) => writeQuery({ [pageKey]: p > 1 ? String(p) : null }), [pageKey]);
  const setPageSize = useCallback(
    (s: number) => writeQuery({ [sizeKey]: s === defaultSize ? null : String(s), [pageKey]: null }),
    [sizeKey, pageKey, defaultSize],
  );
  const handleSort = (key: string) => {
    const dir = sort?.key === key ? (sort.dir === "asc" ? "desc" : "asc") : "asc";
    writeQuery({ [sortKeyName]: key, [dirKey]: dir, [pageKey]: null });
  };
  const resetPage = () => {
    if (ready.current) writeQuery({ [pageKey]: null });
  };

  const baseParams: QueryParams = useMemo(
    () => ({
      page,
      pageSize,
      sort: sort?.key,
      dir: sort?.dir,
      q: applied.trim() || undefined,
    }),
    [page, pageSize, sort, applied],
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
    resetPage,
  };
}
