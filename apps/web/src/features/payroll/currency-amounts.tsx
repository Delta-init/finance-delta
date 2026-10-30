"use client";

import type { ReactNode } from "react";
import { formatMoney } from "@delta/shared";
import { MoneyDisplay } from "@/components/ui/money";
import { Tooltip } from "@/components/ui/tooltip";
import { useCurrency } from "@/lib/currency-context";
import { cn } from "@/lib/utils";

/*
 * Payroll money per currency (2026-10-30).
 *
 * A month can pay some people in dirhams and others in rupees, and adding the
 * two gives a figure that is not an amount of anything: the import screen
 * showed AED 972,458.21 for AED 344,824.88 and INR 627,633.33. So each currency
 * is shown as its own amount, one in another currency also as roughly what it
 * comes to in the screen's currency, and, where one figure helps, the whole at
 * today's rate, marked ≈ because it was calculated rather than recorded.
 */

export interface CurrencyAmount {
  currency: string;
  amountMinor: number;
}

/** The amounts added up in the screen's currency at today's rate; null while a rate is missing. */
export function useApproxTotal(rows: CurrencyAmount[]) {
  const { currency, rateBetween, ratesDate } = useCurrency();
  let minor = 0;
  for (const r of rows) {
    const rate = rateBetween(r.currency, currency);
    if (!rate) return null;
    minor += Math.round(r.amountMinor * rate);
  }
  return { minor, currency, ratesDate };
}

/** "≈ AED 372,467", with the rate's date on hover. `fallback` while a rate is missing. */
export function ApproxTotal({
  rows, className, fallback = null,
}: { rows: CurrencyAmount[]; className?: string; fallback?: ReactNode }) {
  const total = useApproxTotal(rows);
  if (!total) return <>{fallback}</>;
  return (
    <Tooltip
      label={`Each currency converted at today's rate${total.ratesDate ? ` (rates ${total.ratesDate})` : ""} and added up. Everybody is still paid in their own currency.`}
    >
      <span className={cn("font-numeric cursor-help", className)}>≈ {formatMoney(total.minor, total.currency)}</span>
    </Tooltip>
  );
}

/**
 * "AED 344,825 + INR 627,634 ≈ AED 27,642": each currency on its own, never
 * summed, an amount in another currency also as the screen's. `stacked` puts
 * one under the other, for a table cell.
 */
export function AmountsByCurrency({
  rows, className, stacked = false,
}: { rows: CurrencyAmount[]; className?: string; stacked?: boolean }) {
  // Each amount kept on one line ("INR" above "627,633" reads as two figures);
  // only the gap between currencies may wrap.
  if (stacked) {
    return (
      <span className={cn("inline-flex flex-col items-end gap-0.5", className)}>
        {rows.map((r) => (
          <span key={r.currency} className="whitespace-nowrap">
            <MoneyDisplay minor={r.amountMinor} currency={r.currency} showConverted />
          </span>
        ))}
      </span>
    );
  }
  return (
    <span className={className}>
      {rows.map((r, i) => (
        <span key={r.currency}>
          {i > 0 && " + "}
          <span className="whitespace-nowrap">
            <MoneyDisplay minor={r.amountMinor} currency={r.currency} showConverted />
          </span>
        </span>
      ))}
    </span>
  );
}
