"use client";

import { useEffect, useState } from "react";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { useCustomer, useCustomers } from "./api";

/**
 * A customer, picked by searching all of them (the user, 2026-11-03: "searching only works on the client side —
 * fetch only some and search on the server").
 *
 * The invoice and quotation forms used to load the first 100 customers, A to Z, and let the dropdown narrow those —
 * so anybody further down the alphabet could not be found at all. Here what is typed goes to the server, which looks
 * through every customer by name, email, company, phone and customer code; before anything is typed, the first ones
 * A to Z are shown. The one chosen is always shown on the button, whether or not it is in the results.
 *
 * Its own list (cmdk in a popover) rather than the shared Select: results arriving while somebody types would swap
 * the Select's options under it, which is what used to take the focus out of its search box after one letter.
 */
export function CustomerPicker({
  value, onChange, placeholder = "Select a customer…", invalid,
}: {
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
  invalid?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQ(typed.trim()), 250);
    return () => clearTimeout(t);
  }, [typed]);
  useEffect(() => { if (!open) { setTyped(""); setQ(""); } }, [open]);

  const { data, isFetching, isPlaceholderData } = useCustomers(
    { pageSize: 50, sort: "name", dir: "asc", ...(q ? { q } : {}) },
    { enabled: open },
  );
  const { data: chosen } = useCustomer(value || undefined);
  const results = data?.data ?? [];
  // The last search's answer stays up while the next is asked (placeholderData); until it comes, it can't be picked —
  // a quick Enter would otherwise take somebody from the search before.
  const stale = isPlaceholderData || typed.trim() !== q;
  const waiting = isFetching || stale;
  // The first of each fresh answer is the one Enter takes — results arrive after the typing, so cmdk would have
  // nothing highlighted.
  const [highlight, setHighlight] = useState("");
  const first = stale ? "" : results[0]?.id ?? "";
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
          )}
        >
          <span className={cn("line-clamp-1", !chosen && "text-foreground-subtle")}>
            {chosen?.name ?? (value ? "…" : placeholder)}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-foreground-subtle" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-[18rem] p-0">
        {/* The server decides what matches; cmdk only shows it. */}
        <Command shouldFilter={false} value={highlight} onValueChange={setHighlight}>
          <CommandInput value={typed} onValueChange={setTyped} placeholder="Search name, phone, email or code…" />
          <CommandList>
            {waiting && results.length === 0 ? (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-foreground-subtle">
                <Loader2 className="h-4 w-4 animate-spin" /> Searching…
              </div>
            ) : (
              <CommandEmpty>No customer matches “{q}”.</CommandEmpty>
            )}
            {results.map((c) => (
              <CommandItem
                key={c.id}
                value={c.id}
                disabled={stale}
                className={cn(stale && "opacity-50")}
                onSelect={() => { onChange(c.id); setOpen(false); }}
              >
                <Check className={cn("h-4 w-4 shrink-0", c.id === value ? "opacity-100" : "opacity-0")} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{c.name}</span>
                  <span className="block truncate text-xs text-foreground-muted">
                    {[c.customerCode, c.phone, c.email].filter(Boolean).join(" · ")}
                  </span>
                </span>
              </CommandItem>
            ))}
            {results.length > 0 && (data?.meta?.total ?? 0) > results.length && (
              <p className="px-2 py-1.5 text-xs text-foreground-subtle">
                {results.length} of {data?.meta?.total} shown — type more to narrow it down.
              </p>
            )}
            {waiting && results.length > 0 && (
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
