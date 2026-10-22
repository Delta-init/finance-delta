"use client";

import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A date (value/onChange as "YYYY-MM-DD", to match forms + filters), picked with the browser's own date picker (the
 * user, 2026-10-22: "use the native calendar instead of the custom calendar in every date input area") — the
 * browser's calendar on a computer, the phone's date wheel on a phone, and the date can be typed in. The same props
 * as the pop-up calendar it replaced, so every screen using it changed with this file. A native date box shows the
 * browser's own dd/mm/yyyy when empty; `placeholder` is kept as its accessible name.
 */
export function DatePicker({
  value,
  onChange,
  placeholder = "Pick a date",
  clearable = false,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  clearable?: boolean;
  className?: string;
}) {
  const showClear = clearable && !!value;
  return (
    <div className={cn("relative", className)}>
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={placeholder}
        className={cn(
          "h-9 w-full rounded-md border border-border bg-surface px-3 text-sm text-foreground shadow-xs transition-colors focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
          !value && "text-foreground-subtle",
          showClear && "pr-7",
        )}
      />
      {showClear && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear the date"
          title="Clear"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-foreground-subtle hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
