"use client";

import { useEffect, useRef, useState } from "react";
import { CalendarDays, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { maskDmy, parseDmy, toDmy } from "@/lib/dates";

/**
 * A date typed as dd/mm/yyyy, whatever the browser's language, with the browser's own calendar one click away (the
 * user, 2026-11-11: "Petty cash date format issue (shows dd/mm/yyyy - actually happening mm/dd/yyyy)"; the native
 * calendar kept, as asked 2026-10-22). A native date box takes its typing order from the browser — mm/dd/yyyy on an
 * English (US) one — so typing 05/11 meant the 11th of May. Here the text is always day first, and the calendar
 * button opens the native picker, whose answer has no order to get wrong.
 *
 * value / onChange are "YYYY-MM-DD" (or ""), as with <input type="date">. A half-typed or impossible date is shown
 * in red and not passed on; leaving the field puts back the last good date.
 */
export function DateField({
  value,
  onChange,
  id,
  placeholder = "dd/mm/yyyy",
  clearable = false,
  disabled,
  min,
  max,
  className,
  inputClassName,
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange: (iso: string) => void;
  id?: string;
  placeholder?: string;
  clearable?: boolean;
  disabled?: boolean;
  min?: string;
  max?: string;
  className?: string;
  inputClassName?: string;
  "aria-label"?: string;
}) {
  const [text, setText] = useState(() => toDmy(value));
  const picker = useRef<HTMLInputElement>(null);
  // Changed from outside (a reset, a default): shown as it is now.
  useEffect(() => {
    if (parseDmy(text) !== (value || null)) setText(toDmy(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const typed = parseDmy(text);
  const outOfRange = !!typed && ((!!min && typed < min) || (!!max && typed > max));
  const bad = text.trim() !== "" && (!typed || outOfRange);

  const type = (next: string) => {
    const shaped = maskDmy(next);
    setText(shaped);
    const iso = parseDmy(shaped);
    if (iso && !((min && iso < min) || (max && iso > max))) onChange(iso);
    else if (!shaped.trim() && value) onChange("");
  };
  const openCalendar = () => {
    const el = picker.current;
    if (!el || disabled) return;
    try {
      if (typeof el.showPicker === "function") el.showPicker();
      else el.click();
    } catch {
      el.focus();
    }
  };
  const showClear = clearable && !!value && !disabled;

  return (
    <div className={cn("relative", className)}>
      <input
        id={id}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        value={text}
        placeholder={placeholder}
        aria-label={ariaLabel ?? (id ? undefined : placeholder)}
        aria-invalid={bad || undefined}
        disabled={disabled}
        title={bad ? (outOfRange ? "Outside the dates allowed here" : "Type the date as dd/mm/yyyy") : undefined}
        onChange={(e) => type(e.target.value)}
        onBlur={() => { if (bad || (!text.trim() && !value)) setText(toDmy(value)); }}
        className={cn(
          "h-9 w-full rounded-md border border-border bg-surface pl-3 text-sm text-foreground shadow-xs transition-colors placeholder:text-foreground-subtle focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50",
          showClear ? "pr-14" : "pr-8",
          bad && "border-danger focus-visible:border-danger",
          inputClassName,
        )}
      />
      {showClear && (
        <button
          type="button"
          onClick={() => { setText(""); onChange(""); }}
          aria-label="Clear the date"
          title="Clear"
          className="absolute right-7 top-1/2 -translate-y-1/2 rounded p-0.5 text-foreground-subtle hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
      <button
        type="button"
        onClick={openCalendar}
        disabled={disabled}
        aria-label="Pick from the calendar"
        title="Pick from the calendar"
        className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-foreground-subtle hover:text-foreground disabled:opacity-50"
      >
        <CalendarDays className="h-4 w-4" />
      </button>
      {/* The browser's own calendar, opened by the button: what it gives back is a date, not text in some order. */}
      <input
        ref={picker}
        type="date"
        tabIndex={-1}
        aria-hidden
        value={value || ""}
        min={min}
        max={max}
        onChange={(e) => { setText(toDmy(e.target.value)); onChange(e.target.value); }}
        className="pointer-events-none absolute bottom-0 right-0 h-0 w-0 opacity-0"
      />
    </div>
  );
}
