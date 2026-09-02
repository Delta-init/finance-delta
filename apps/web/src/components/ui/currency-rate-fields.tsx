"use client";

import { formatMoney, toBaseMinor } from "@delta/shared";
import { CURRENCIES } from "@/lib/currency-context";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

/**
 * Choosing a currency, and saying what it is worth.
 *
 * Shows nothing but the picker while the document is in the organization's own
 * currency, which is almost always — an AED business raising AED invoices
 * should not have to look at a conversion of one to one.
 *
 * The rate is editable on purpose. A rate agreed in a contract beats whatever a
 * public feed says this morning, and the feed is not always reachable. It is
 * pre-filled, with the date it came from, so the common case is still one
 * glance and no typing.
 */
export function CurrencyRateFields({
  currency,
  onCurrencyChange,
  baseCurrency,
  rate,
  onRateChange,
  ratesDate,
  amountMinor,
  disabled,
}: {
  currency: string;
  onCurrencyChange: (c: string) => void;
  baseCurrency: string;
  /** One unit of the base currency buys this many of `currency`. */
  rate: string;
  onRateChange: (r: string) => void;
  ratesDate?: string;
  /** What the document currently comes to, for the live conversion. */
  amountMinor: number;
  disabled?: boolean;
}) {
  const foreign = currency !== baseCurrency;
  const parsed = Number(rate);
  const usable = Number.isFinite(parsed) && parsed > 0;

  return (
    <>
      <div className="space-y-1.5">
        <Label>Currency</Label>
        <Select value={currency} onValueChange={onCurrencyChange} disabled={disabled}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {/* The list the rate table actually carries, so a currency can
                never be picked that no rate exists for. */}
            {CURRENCIES.map((c) => (
              <SelectItem key={c.code} value={c.code}>
                {c.code} — {c.name}
                {c.code === baseCurrency ? " (yours)" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {foreign && (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="fx-rate">
              Rate (1 {baseCurrency} = ? {currency})
            </Label>
            <Input
              id="fx-rate"
              type="number"
              step="0.0001"
              min="0"
              value={rate}
              disabled={disabled}
              placeholder="0.0000"
              onChange={(e) => onRateChange(e.target.value)}
            />
            {ratesDate && usable ? (
              <p className="text-xs text-foreground-muted">Rate as at {ratesDate}. Change it if yours differs.</p>
            ) : (
              <p className="text-xs text-danger">
                No rate yet — type the one you agreed. Nothing is saved without it.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>In {baseCurrency}</Label>
            <div className="flex h-9 items-center rounded-md border border-border bg-surface-muted px-3 text-sm">
              <span className="font-numeric font-medium">
                {usable ? formatMoney(toBaseMinor(amountMinor, parsed), baseCurrency) : "—"}
              </span>
            </div>
            <p className="text-xs text-foreground-muted">
              What this comes to in your own currency. Worked out, not typed.
            </p>
          </div>
        </>
      )}
    </>
  );
}
