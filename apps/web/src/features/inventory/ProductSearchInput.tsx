"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { UseFormRegisterReturn } from "react-hook-form";
import { Clock } from "lucide-react";
import { formatMoney, type Item } from "@delta/shared";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useSuggestions } from "@/features/suggestions/api";

/**
 * Line-item description input with product autocomplete. Type freely for a
 * custom product, or pick a catalog item — the parent decides what to fill
 * (price, itemId, …) via onPick. onType fires on manual edits so the parent
 * can clear any product link. If onPickText is provided, previously-typed
 * line descriptions are also offered under a "Recently used" section.
 */
export function ProductSearchInput({
  query,
  registerProps,
  onType,
  onPick,
  onPickText,
  currency,
}: {
  query: string;
  registerProps: UseFormRegisterReturn;
  onType: () => void;
  onPick: (item: Item) => void;
  onPickText?: (text: string) => void;
  currency: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const [debouncedQ, setDebouncedQ] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  // The line-items table clips overflow, so the dropdown is fixed-positioned
  // against the viewport instead of the row.
  useEffect(() => {
    if (!open) return;
    const update = () => {
      const r = wrapRef.current?.getBoundingClientRect();
      if (r) setRect({ top: r.bottom + 4, left: r.left, width: Math.max(r.width, 280) });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open]);

  const enabled = open && debouncedQ.length >= 2;
  const { data: matches } = useQuery({
    queryKey: ["inventory", "items", "line-search", debouncedQ],
    queryFn: () => api.getList<Item>("inventory/items", { q: debouncedQ, pageSize: 8, isActive: "true" }),
    enabled,
    placeholderData: (prev) => prev,
  });
  const options = enabled ? matches?.data ?? [] : [];

  // "Recently used" custom descriptions (only when the parent wants them).
  const historyEnabled = !!onPickText && open && debouncedQ.length >= 2;
  const { data: historyRaw } = useSuggestions("lineDescription", debouncedQ, historyEnabled);
  const productNames = new Set(options.map((o) => o.name.toLowerCase()));
  const history = historyEnabled
    ? (historyRaw ?? [])
        .filter((s) => s.toLowerCase() !== query.trim().toLowerCase() && !productNames.has(s.toLowerCase()))
        .slice(0, 5)
    : [];

  const hasMenu = options.length > 0 || history.length > 0;

  return (
    <div className="relative" ref={wrapRef}>
      <Input
        className="h-8"
        autoComplete="off"
        placeholder="Type or search product…"
        {...registerProps}
        onChange={(e) => {
          registerProps.onChange(e);
          onType();
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={(e) => {
          registerProps.onBlur(e);
          setTimeout(() => setOpen(false), 150);
        }}
      />
      {open && hasMenu && rect && (
        <div
          className="fixed z-50 max-h-72 overflow-y-auto rounded-md border border-border bg-surface shadow-md"
          style={{ top: rect.top, left: rect.left, width: rect.width }}
        >
          {options.length > 0 && (
            <p className="px-3 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-foreground-subtle">
              Products
            </p>
          )}
          {options.map((item) => (
            <button
              key={item.id}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(item);
                setOpen(false);
              }}
              className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-surface-muted"
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">{item.name}</span>
                <span className="block truncate text-xs text-foreground-subtle">{item.sku}</span>
              </span>
              <span className="shrink-0 font-numeric text-xs text-foreground-muted">
                {formatMoney(item.unitPriceMinor, currency)}
              </span>
            </button>
          ))}
          {history.length > 0 && (
            <>
              <p className="px-3 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-foreground-subtle">
                Recently used
              </p>
              {history.map((text) => (
                <button
                  key={text}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onPickText?.(text);
                    setOpen(false);
                  }}
                  className="flex w-full items-start gap-2 px-3 py-2 text-left text-sm hover:bg-surface-muted"
                >
                  <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground-subtle" />
                  <span className="truncate">{text}</span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
