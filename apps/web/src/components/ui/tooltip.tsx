"use client";

import type { ReactNode } from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "@/lib/utils";

/**
 * A label for a control that shows only an icon.
 *
 * Portalled rather than positioned inside the row, because the tables it is
 * mostly used in scroll horizontally: anything absolutely positioned within
 * them is clipped at the edge, which is exactly where the row's buttons sit.
 *
 * `label` is also the accessible name, so a screen reader and a pointer are
 * told the same thing and neither depends on a `title` attribute — which would
 * otherwise show a second, native tooltip underneath this one.
 */
export function Tooltip({
  label,
  children,
  side = "top",
  className,
}: {
  label: string;
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  className?: string;
}) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className={cn(
            "z-50 rounded-md bg-foreground px-2 py-1 text-xs font-medium text-surface shadow-md",
            "animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
            className,
          )}
        >
          {label}
          <TooltipPrimitive.Arrow className="fill-foreground" />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

/**
 * Wraps the app once so tooltips share a delay.
 *
 * Without a provider each tooltip waits its own 700ms; with one, moving between
 * neighbouring icons shows the next label immediately, which is how a row of
 * buttons is actually read.
 */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <TooltipPrimitive.Provider delayDuration={300} skipDelayDuration={300}>
      {children}
    </TooltipPrimitive.Provider>
  );
}
