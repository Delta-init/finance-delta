"use client";

import { motion } from "framer-motion";
import { formatMoney } from "@delta/shared";

/**
 * One line of a totals panel: a label, and a figure that flashes when it moves.
 *
 * Shared by the invoice and quotation forms, which each had their own identical
 * copy declared inside their totals component. That placement was the bug worth
 * removing: React tells components apart by function identity, so a component
 * built in a render body is a new component on every render and its subtree is
 * rebuilt rather than updated — which replayed the fade on every keystroke,
 * whether or not the number had actually changed.
 *
 * The `key` on the figure is what makes the animation mean something: it
 * remounts only when the value really changes, so the flash marks a change
 * rather than a render.
 */
export function TotalRow({
  label,
  value,
  currency,
  strong,
}: {
  label: string;
  value: number;
  currency: string;
  strong?: boolean;
}) {
  return (
    <div
      className={`flex justify-between gap-8 ${
        strong ? "border-t border-border pt-2 text-base font-semibold" : "text-sm text-foreground-muted"
      }`}
    >
      <span>{label}</span>
      <motion.span
        key={value}
        initial={{ opacity: 0.4 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.2 }}
        className="font-numeric text-foreground"
      >
        {formatMoney(value, currency)}
      </motion.span>
    </div>
  );
}
