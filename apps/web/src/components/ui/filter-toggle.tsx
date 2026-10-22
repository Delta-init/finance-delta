"use client";

import { SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The Filters button beside Export (the user, 2026-10-22: "filter button along with export — only visible when
 * clicked"): a list's filters stay folded away until it is pressed, and it says how many are set, so a filtered list
 * is never taken for the whole one.
 */
export function FilterToggle({ open, onToggle, count = 0, size = "md" }: { open: boolean; onToggle: () => void; count?: number; size?: "sm" | "md" }) {
  return (
    <Button
      variant="outline"
      size={size}
      onClick={onToggle}
      aria-expanded={open}
      className={cn(open && "border-primary/50 bg-primary/5 text-primary")}
    >
      <SlidersHorizontal className="h-4 w-4" />
      Filters
      {count > 0 && (
        <span className="ml-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold leading-none text-primary-foreground">
          {count}
        </span>
      )}
    </Button>
  );
}
