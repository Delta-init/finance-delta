"use client";

import type { OtherCurrencyLine } from "@delta/shared";
import { MoneyDisplay } from "@/components/ui/money";
import { cn } from "@/lib/utils";

/**
 * What a report left out because it is in another currency than the organization's (the user, 2026-11-26: "fix the
 * same currency mixing in the dashboard and the other reports too" — rupees were added into dirham totals as dirhams).
 * A line per currency and per figure it would have gone into, each in its own currency: never converted, never added
 * in. Several reports on one page each pass their own lines. Renders nothing when there is none.
 */
export function OtherCurrencies({ lines, className }: { lines?: (OtherCurrencyLine[] | undefined)[] | OtherCurrencyLine[]; className?: string }) {
  const all = ((lines ?? []) as unknown[]).flat().filter(Boolean) as OtherCurrencyLine[];
  // The same figure from two reports on one page (what is owed, listed and summarised) is said once.
  const seen = new Map<string, OtherCurrencyLine>();
  for (const l of all) if (!seen.has(`${l.currency}|${l.what}`)) seen.set(`${l.currency}|${l.what}`, l);
  const shown = [...seen.values()];
  if (!shown.length) return null;
  return (
    <div className={cn("rounded-xl border border-warning/40 bg-surface p-4", className)}>
      <p className="text-sm font-semibold">In other currencies</p>
      <p className="mt-0.5 text-xs text-foreground-muted">Not in the figures here, and never converted.</p>
      <ul className="mt-2 space-y-1">
        {shown.map((l) => (
          <li key={`${l.currency}|${l.what}`} className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
            <span className="text-foreground-muted">
              {l.what} · {l.count.toLocaleString()} {l.count === 1 ? "record" : "records"}
            </span>
            <MoneyDisplay minor={l.amountMinor} currency={l.currency} className="font-medium tabular-nums text-warning" />
          </li>
        ))}
      </ul>
    </div>
  );
}
