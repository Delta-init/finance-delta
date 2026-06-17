"use client";

import { Check, Minus } from "lucide-react";
import { cn } from "@/lib/utils";

interface CheckboxProps {
  checked?: boolean;
  indeterminate?: boolean;
  onChange?: () => void;
  /** "default" = on light surfaces; "onPrimary" = on the blue table header */
  variant?: "default" | "onPrimary";
  "aria-label"?: string;
  className?: string;
}

export function Checkbox({
  checked = false,
  indeterminate = false,
  onChange,
  variant = "default",
  className,
  "aria-label": ariaLabel,
}: CheckboxProps) {
  const on = checked || indeterminate;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? "mixed" : checked}
      aria-label={ariaLabel}
      onClick={onChange}
      className={cn(
        "flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1",
        variant === "default"
          ? on
            ? "border-primary bg-primary text-white focus-visible:ring-ring"
            : "border-border-strong bg-surface hover:border-primary focus-visible:ring-ring"
          : on
            ? "border-white bg-white text-primary focus-visible:ring-white"
            : "border-white/60 bg-white/0 hover:bg-white/15 focus-visible:ring-white",
        className,
      )}
    >
      {indeterminate ? (
        <Minus className="h-3 w-3" strokeWidth={3} />
      ) : checked ? (
        <Check className="h-3 w-3" strokeWidth={3} />
      ) : null}
    </button>
  );
}
