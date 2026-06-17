"use client";

import { useState } from "react";
import { ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Checkbox } from "./checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./command";

export interface MultiSelectOption {
  value: string;
  label: string;
  /** Optional CSS color for a leading dot (e.g. an oklch string). */
  color?: string;
}

export function MultiSelect({
  options,
  value,
  onChange,
  placeholder = "Select…",
  emptyText = "No options.",
  className,
}: {
  options: MultiSelectOption[];
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  emptyText?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.filter((o) => value.includes(o.value));

  const toggle = (v: string) =>
    onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex min-h-9 w-full flex-wrap items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-sm shadow-xs transition-colors hover:bg-surface-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30",
            className,
          )}
        >
          {selected.length === 0 && (
            <span className="px-1 text-foreground-subtle">{placeholder}</span>
          )}
          {selected.map((o) => (
            <span
              key={o.value}
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
              style={
                o.color
                  ? {
                      backgroundColor: `color-mix(in oklch, ${o.color} 15%, white)`,
                      color: `color-mix(in oklch, ${o.color} 70%, black)`,
                    }
                  : undefined
              }
            >
              {o.label}
            </span>
          ))}
          <ChevronsUpDown className="ml-auto h-4 w-4 shrink-0 text-foreground-subtle" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0">
        <Command>
          <CommandInput placeholder="Search…" />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            <CommandGroup>
              {options.map((o) => (
                <CommandItem key={o.value} value={o.label} onSelect={() => toggle(o.value)}>
                  <Checkbox checked={value.includes(o.value)} />
                  {o.color && (
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: o.color }}
                    />
                  )}
                  <span className="truncate">{o.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
