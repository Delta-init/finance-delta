"use client";

import { useEffect, useRef, useState } from "react";
import { Clock } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useSuggestions, type SuggestionField } from "@/features/suggestions/api";

/**
 * Text input / textarea with type-ahead suggestions from previously-entered
 * values for the given field. Purely additive — the user can still type
 * anything; suggestions are just shortcuts. The dropdown is fixed-positioned
 * so it isn't clipped by scroll containers.
 */
export function SuggestInput({
  value,
  onChange,
  field,
  placeholder,
  multiline = false,
  rows = 3,
  className,
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  field: SuggestionField;
  placeholder?: string;
  multiline?: boolean;
  rows?: number;
  className?: string;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const [debouncedQ, setDebouncedQ] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(value.trim()), 200);
    return () => clearTimeout(t);
  }, [value]);

  useEffect(() => {
    if (!open) return;
    const update = () => {
      const r = wrapRef.current?.getBoundingClientRect();
      if (r) setRect({ top: r.bottom + 4, left: r.left, width: Math.max(r.width, 220) });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open]);

  const { data } = useSuggestions(field, debouncedQ, open);
  // Hide an exact match (nothing to suggest if you've already typed it fully).
  const options = (data ?? []).filter((s) => s.toLowerCase() !== value.trim().toLowerCase()).slice(0, 8);

  const dropdown = open && options.length > 0 && rect && (
    <div
      className="fixed z-50 max-h-64 overflow-y-auto rounded-md border border-border bg-surface shadow-md"
      style={{ top: rect.top, left: rect.left, width: rect.width }}
    >
      <p className="px-3 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-foreground-subtle">
        Recently used
      </p>
      {options.map((s) => (
        <button
          key={s}
          type="button"
          onMouseDown={(e) => {
            e.preventDefault();
            onChange(s);
            setOpen(false);
          }}
          className="flex w-full items-start gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface-muted"
        >
          <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground-subtle" />
          <span className="whitespace-pre-wrap break-words">{s}</span>
        </button>
      ))}
    </div>
  );

  const shared = {
    id,
    value,
    placeholder,
    autoComplete: "off",
    onFocus: () => setOpen(true),
    onBlur: () => setTimeout(() => setOpen(false), 150),
  };

  return (
    <div className="relative" ref={wrapRef}>
      {multiline ? (
        <textarea
          {...shared}
          rows={rows}
          onChange={(e) => { onChange(e.target.value); setOpen(true); }}
          className={cn(
            "w-full rounded-md border border-border bg-surface px-3 py-2 text-sm shadow-xs focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
            className,
          )}
        />
      ) : (
        <Input
          {...shared}
          onChange={(e) => { onChange(e.target.value); setOpen(true); }}
          className={className}
        />
      )}
      {dropdown}
    </div>
  );
}
