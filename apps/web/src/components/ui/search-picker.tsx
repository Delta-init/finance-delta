"use client";

import { useEffect, useState, type ReactNode } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { api, type QueryParams } from "@/lib/api";
import { cn } from "@/lib/utils";

/** What the picker shows of one result. */
export interface PickerRow<T> { id: string; label: ReactNode; detail?: ReactNode; item: T }

/**
 * Picking one record out of a list too long to load whole — by searching all of it on the server (the user,
 * 2026-11-03: customers, then "the other pickers also").
 *
 * The forms used to load a first page (100 customers A–Z; 10 vendors, the API ignoring the "limit" they asked; 500
 * products, which the API refuses above 100) and let the dropdown narrow that page, so whatever was past it could not
 * be found. Here what is typed goes to the list's own search on the server; before anything is typed, the first ones
 * by name are shown. The chosen one is always on the button (`selectedLabel`), in the results or not.
 *
 * Its own list (cmdk in a popover) rather than the shared Select: results arriving while somebody types would swap the
 * Select's options under it, which is what used to take the focus out of its search box after one letter.
 */
export function SearchPicker<T>({
  value, onChange, selectedLabel, path, params, toRow, queryKey,
  placeholder, searchPlaceholder, noun, invalid, defaultOpen, className,
}: {
  value: string;
  onChange: (id: string, item: T) => void;
  /** The chosen one's name, for the button. */
  selectedLabel?: ReactNode;
  /** The list endpoint, e.g. "customers" — it must take `q`, `pageSize`, `sort`, `dir`. */
  path: string;
  /** Fixed filters, e.g. { isActive: "true" }. */
  params?: QueryParams;
  toRow: (item: T) => PickerRow<T>;
  queryKey: readonly unknown[];
  placeholder: string;
  searchPlaceholder: string;
  /** "customer", "vendor"… for "No customer matches". */
  noun: string;
  invalid?: boolean;
  /** Open as it appears — a row just added, waiting for its pick. */
  defaultOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQ(typed.trim()), 250);
    return () => clearTimeout(t);
  }, [typed]);
  useEffect(() => { if (!open) { setTyped(""); setQ(""); } }, [open]);

  const query = { pageSize: 50, sort: "name", dir: "asc", ...params, ...(q ? { q } : {}) };
  const { data, isFetching, isPlaceholderData } = useQuery({
    queryKey: [...queryKey, query],
    queryFn: () => api.getList<T>(path, query),
    enabled: open,
    placeholderData: keepPreviousData,
  });
  const rows = (data?.data ?? []).map(toRow);
  // The last search's answer stays up while the next is asked; until it comes, it can't be picked — a quick Enter
  // would otherwise take one from the search before.
  const stale = isPlaceholderData || typed.trim() !== q;
  const waiting = isFetching || stale;
  // The first of each fresh answer is the one Enter takes — results arrive after the typing, so cmdk would have
  // nothing highlighted.
  const [highlight, setHighlight] = useState("");
  const first = stale ? "" : rows[0]?.id ?? "";
  useEffect(() => { setHighlight(first); }, [first, q]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          className={cn(
            "flex h-9 w-full items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 text-left text-sm shadow-xs transition-colors focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30",
            invalid && "border-danger",
            className,
          )}
        >
          <span className={cn("line-clamp-1", !selectedLabel && "text-foreground-subtle")}>
            {selectedLabel ?? (value ? "…" : placeholder)}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-foreground-subtle" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-[18rem] p-0">
        {/* The server decides what matches; cmdk only shows it. */}
        <Command shouldFilter={false} value={highlight} onValueChange={setHighlight}>
          <CommandInput value={typed} onValueChange={setTyped} placeholder={searchPlaceholder} />
          <CommandList>
            {waiting && rows.length === 0 ? (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-foreground-subtle">
                <Loader2 className="h-4 w-4 animate-spin" /> Searching…
              </div>
            ) : (
              <CommandEmpty>{q ? `No ${noun} matches “${q}”.` : `No ${noun}s yet.`}</CommandEmpty>
            )}
            {rows.map((r) => (
              <CommandItem
                key={r.id}
                value={r.id}
                disabled={stale}
                className={cn(stale && "opacity-50")}
                onSelect={() => { onChange(r.id, r.item); setOpen(false); }}
              >
                <Check className={cn("h-4 w-4 shrink-0", r.id === value ? "opacity-100" : "opacity-0")} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{r.label}</span>
                  {r.detail ? <span className="block truncate text-xs text-foreground-muted">{r.detail}</span> : null}
                </span>
              </CommandItem>
            ))}
            {rows.length > 0 && (data?.meta?.total ?? 0) > rows.length && (
              <p className="px-2 py-1.5 text-xs text-foreground-subtle">
                {rows.length} of {data?.meta?.total} shown — type more to narrow it down.
              </p>
            )}
            {waiting && rows.length > 0 && (
              <p className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-foreground-subtle">
                <Loader2 className="h-3 w-3 animate-spin" /> Searching…
              </p>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
