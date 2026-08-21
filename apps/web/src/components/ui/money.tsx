"use client";

import { formatMoney } from "@delta/shared";
import { cn } from "@/lib/utils";
import { useCurrency } from "@/lib/currency-context";

/**
 * Renders money minor units.
 *
 * When a `currency` is given, the amount is already denominated in that
 * currency (e.g. an invoice/bill/payment total in the document's own
 * currency) and is shown as-is — no FX conversion. This is the correct
 * behavior for financial documents and avoids the earlier bug where a
 * non-AED org's totals were multiplied by the FX rate.
 *
 * When no `currency` is given, the amount is treated as an
 * organization-base-currency figure and converted to the user's selected
 * display currency for aggregate views.
 */
export function MoneyDisplay({
  minor,
  currency: sourceCurrency,
  className,
}: {
  minor: number;
  /** The currency the amount is already in. If set, it is shown without conversion. */
  currency?: string;
  className?: string;
}) {
  const { currency: displayCurrency, convert } = useCurrency();
  if (sourceCurrency) {
    return <span className={cn("font-numeric", className)}>{formatMoney(minor, sourceCurrency)}</span>;
  }
  return (
    <span className={cn("font-numeric", className)}>
      {formatMoney(convert(minor), displayCurrency)}
    </span>
  );
}
