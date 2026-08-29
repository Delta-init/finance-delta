"use client";

import { formatMoney } from "@delta/shared";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";
import { useCurrency, type CurrencyCode } from "@/lib/currency-context";

/**
 * Renders money minor units.
 *
 * Two cases, and the difference between them matters:
 *
 * A figure with its own `currency` — an invoice total, a bank balance, a
 * payroll run — is shown in that currency, untouched. Restating an INR invoice
 * as dirhams would be inventing a number the document does not contain.
 *
 * A figure without one is an aggregate held in the organization's base
 * currency, and is converted to whatever the reader has selected.
 *
 * Either way, when the number on screen is not the number in the record, it
 * says so. A converted figure that looks identical to a native one is how
 * somebody reads a rupee total as dirhams — a factor of twenty-two, presented
 * with no hint that anything happened to it.
 */
export function MoneyDisplay({
  minor,
  currency: sourceCurrency,
  className,
  /**
   * Also show what this comes to in the reader's display currency, when that
   * differs from the amount's own. Off by default: on a list of thirty
   * invoices it is noise, but on a total somebody is about to act on it is
   * the whole point.
   */
  showConverted = false,
}: {
  minor: number;
  /** The currency the amount is already in. If set, it is shown in that currency. */
  currency?: string;
  className?: string;
  showConverted?: boolean;
}) {
  const { currency: displayCurrency, baseCurrency, convert, rateFor, ratesDate } = useCurrency();

  // ── The amount carries its own currency ────────────────────────────────────
  if (sourceCurrency) {
    const native = formatMoney(minor, sourceCurrency);
    const differs = sourceCurrency !== displayCurrency;

    if (!differs || !showConverted) {
      return <span className={cn("font-numeric", className)}>{native}</span>;
    }

    // Cross-rate: both sides are quoted against AED, so one divides out.
    const from = rateFor(sourceCurrency as CurrencyCode);
    const to = rateFor(displayCurrency);
    if (!from) return <span className={cn("font-numeric", className)}>{native}</span>;

    const asDisplay = Math.round((minor * to) / from);
    const perUnit = (to / from).toFixed(4);

    return (
      <span className={cn("font-numeric", className)}>
        {native}
        <Tooltip
          label={`Converted at 1 ${sourceCurrency} = ${perUnit} ${displayCurrency}${ratesDate ? ` (rates ${ratesDate})` : ""}. The record is in ${sourceCurrency}.`}
        >
          <span className="ml-1.5 cursor-help whitespace-nowrap text-xs font-normal text-foreground-muted">
            ≈ {formatMoney(asDisplay, displayCurrency)}
          </span>
        </Tooltip>
      </span>
    );
  }

  // ── An aggregate in the organization's base currency ───────────────────────
  const converted = displayCurrency !== baseCurrency;
  const value = formatMoney(convert(minor), displayCurrency);

  if (!converted) return <span className={cn("font-numeric", className)}>{value}</span>;

  const perUnit = (rateFor(displayCurrency) / (rateFor(baseCurrency as CurrencyCode) || 1)).toFixed(4);
  return (
    <Tooltip
      label={`Converted from ${baseCurrency} at 1 ${baseCurrency} = ${perUnit} ${displayCurrency}${ratesDate ? ` (rates ${ratesDate})` : ""}. The records are held in ${baseCurrency}.`}
    >
      <span className={cn("font-numeric cursor-help", className)}>
        {/* The tilde is the whole warning: this figure was calculated, not
            recorded, and the rate it used moves daily. */}
        ≈ {value}
      </span>
    </Tooltip>
  );
}
