"use client";

import { Calendar as CalendarIcon, X } from "lucide-react";
import { Calendar } from "./calendar";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { cn } from "@/lib/utils";

/** value/onChange use ISO date strings ("YYYY-MM-DD") to match forms + filters. */
function toYMD(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

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
  const date = value ? new Date(`${value}T00:00:00`) : undefined;
  const label = date
    ? date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
    : placeholder;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex h-9 items-center gap-2 rounded-md border border-border bg-surface px-3 text-sm shadow-xs transition-colors hover:bg-surface-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30",
            !value && "text-foreground-subtle",
            className,
          )}
        >
          <CalendarIcon className="h-4 w-4 shrink-0 text-foreground-subtle" />
          <span className="flex-1 text-nowrap text-left">{label}</span>
          {clearable && value && (
            <X
              className="h-3.5 w-3.5 text-foreground-subtle hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation();
                onChange("");
              }}
            />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0">
        <Calendar
          mode="single"
          selected={date}
          onSelect={(d) => onChange(d ? toYMD(d) : "")}
          defaultMonth={date}
        />
      </PopoverContent>
    </Popover>
  );
}
