"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useDebounced } from "@/hooks/use-debounced";

/*
 * A list's filters, search, sort and page kept in the address bar (the user, 2026-10-22: "filtering will mark on the
 * query and read from the query also, and pagination also") — so a refresh, a shared link or coming back from a
 * record shows the same view. Changed in place: no new history entry for each change (Back leaves the page), and no
 * trip to the server — Next keeps useSearchParams in step with the browser's own history calls.
 */

export type QueryPatch = Record<string, string | readonly string[] | null | undefined>;

/** Set or drop some of the address bar's query; an empty value is left out. */
export function writeQuery(patch: QueryPatch): void {
  const p = new URLSearchParams(window.location.search);
  for (const [k, v] of Object.entries(patch)) {
    if (v == null || v === "" || (Array.isArray(v) && v.length === 0)) p.delete(k);
    else p.set(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  const qs = p.toString();
  const next = `${window.location.pathname}${qs ? `?${qs}` : ""}`;
  if (next !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(null, "", next);
}

interface ParamOptions {
  /** The page number this filter sends back to 1 — "page", unless the table keeps its own under a prefix. */
  page?: string;
}

/**
 * One filter in the address bar, used like useState. Its default is left out of the address; anything not in
 * `allowed` reads as the default. Changing it goes back to page 1.
 */
export function useUrlParam<T extends string = string>(
  key: string,
  fallback: NoInfer<T>,
  opts?: ParamOptions & { allowed?: readonly string[] },
): [T, (v: T) => void] {
  const raw = useSearchParams().get(key);
  const allowed = opts?.allowed;
  const value = (raw != null && raw !== "" && (!allowed || allowed.includes(raw)) ? raw : fallback) as T;
  const page = opts?.page ?? "page";
  const set = useCallback((v: T) => writeQuery({ [key]: v === fallback ? null : v, [page]: null }), [key, fallback, page]);
  return [value, set];
}

/** Several values under one key, comma-separated (tags, statuses). */
export function useUrlListParam(key: string, opts?: ParamOptions): [string[], (v: string[]) => void] {
  const raw = useSearchParams().get(key) ?? "";
  const value = useMemo(() => (raw ? raw.split(",").filter(Boolean) : []), [raw]);
  const page = opts?.page ?? "page";
  const set = useCallback((v: string[]) => writeQuery({ [key]: v, [page]: null }), [key, page]);
  return [value, set];
}

/** A page number of a list that does not use useTableQuery; page 1 is left out. */
export function useUrlPage(key = "page"): [number, (p: number) => void] {
  const page = Math.max(1, Math.floor(Number(useSearchParams().get(key))) || 1);
  const set = useCallback((p: number) => writeQuery({ [key]: p > 1 ? String(p) : null }), [key]);
  return [page, set];
}

/** A yes/no filter: present as "1" when on. */
export function useUrlFlag(key: string, opts?: ParamOptions): [boolean, (v: boolean) => void] {
  const on = useSearchParams().get(key) === "1";
  const page = opts?.page ?? "page";
  const set = useCallback((v: boolean) => writeQuery({ [key]: v ? "1" : null, [page]: null }), [key, page]);
  return [on, set];
}

/**
 * Typed text (a search box): what is in the box, its setter, and what is in the address — written once typing
 * pauses, which is the one to query by. Cleared or changed from outside (Clear, a link), the box follows.
 */
export function useUrlText(key: string, opts?: ParamOptions & { delay?: number }): [string, (v: string) => void, string] {
  const raw = useSearchParams().get(key) ?? "";
  const [text, setText] = useState(raw);
  const typed = useDebounced(text, opts?.delay ?? 300);
  const seen = useRef(raw);
  const page = opts?.page ?? "page";
  useEffect(() => {
    if (typed === seen.current) return;
    seen.current = typed;
    writeQuery({ [key]: typed || null, [page]: null });
  }, [typed, key, page]);
  useEffect(() => {
    if (raw === seen.current) return;
    seen.current = raw;
    setText(raw);
  }, [raw]);
  return [text, setText, raw];
}

/** How many of a page's filters are set — for the Filters button. "all", "", false and [] are not. */
export function countFilters(...values: unknown[]): number {
  return values.filter((v) => (Array.isArray(v) ? v.length > 0 : v !== "all" && v !== "" && v !== false && v != null)).length;
}
