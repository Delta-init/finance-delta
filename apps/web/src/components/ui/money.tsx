"use client";

import { formatMoney } from "@delta/shared";
import { cn } from "@/lib/utils";
import { useCurrency } from "@/lib/currency-context";

/**
 * Renders AED minor units as formatted currency in the user's selected
 * display currency, converting on the fly with live FX rates.
 * The `currency` prop is accepted for compat but ignored — always uses context.
 */
export function MoneyDisplay({
  minor,
  currency: _ignored,
  className,
}: {
  minor: number;
  /** @deprecated Ignored — display currency comes from CurrencyContext. */
  currency?: string;
  className?: string;
}) {
  const { currency, convert } = useCurrency();
  return (
    <span className={cn("font-numeric", className)}>
      {formatMoney(convert(minor), currency)}
    </span>
  );
}
