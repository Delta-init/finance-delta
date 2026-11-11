"use client";

import { DateField } from "@/components/ui/date-field";

/**
 * A date (value/onChange as "YYYY-MM-DD", to match forms + filters). Typed as dd/mm/yyyy whatever the browser's
 * language, with the browser's own calendar on its button (2026-11-11 — see DateField; the native calendar kept, as
 * the user asked 2026-10-22). The same props as before, so every screen using it changed with this file;
 * `placeholder` is kept as its accessible name.
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
  return <DateField value={value} onChange={onChange} aria-label={placeholder} clearable={clearable} className={className} />;
}
