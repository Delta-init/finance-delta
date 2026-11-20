"use client";

import { formatMoney, paymentMethodLabel, type PaymentListSummary, type PaymentListSummaryCurrency, type PaymentListSummaryMethod } from "@delta/shared";
import { Loader2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { MoneyDisplay } from "@/components/ui/money";
import { cn } from "@/lib/utils";
import { useCurrency } from "@/lib/currency-context";

/** How many methods a currency lists before the rest are folded into "n more". */
const METHODS_SHOWN = 4;

const plural = (n: number, one: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : `${one}s`}`;

/**
 * The Payments list's cards (the user, 2026-11-20: "add stats cards in the payments page also"): what the filters match
 * — how many payments, what was received, and by method — a line per currency, never added together. From the server
 * with the table's own filters, so the two always agree.
 *
 * Money paid in another currency than its invoice's (rupees on an AED invoice) has a card of its own, as on the Invoices
 * cards: shown as it was paid, never converted, and not in Received. One whose amount in that currency was never
 * recorded stays in Received, and the card says how many.
 */
export function PaymentSummaryCards({ summary, loading, refreshing = false }: { summary: PaymentListSummary | undefined; loading: boolean; /** The last filters' figures, while the new ones load. */ refreshing?: boolean }) {
  const { baseCurrency } = useCurrency();
  if (!summary && !loading) return null;
  // The organization's own currency first, then the others by how many — the same order on every card.
  const rows = [...(summary?.byCurrency ?? [])].sort((a, b) =>
    a.currency === baseCurrency ? -1 : b.currency === baseCurrency ? 1 : b.count - a.count || a.currency.localeCompare(b.currency));
  const otherRows = rows.filter((g) => (g.foreign ?? []).length > 0);
  const skeleton = (w: string) => <div className={cn("h-6 animate-pulse rounded bg-surface-muted", w)} />;
  const waiting = loading && !summary;

  // A currency's methods, largest first; the rest as "n more".
  const methodLines = (currency: string, methods: PaymentListSummaryMethod[]) => {
    const shown = methods.slice(0, METHODS_SHOWN);
    const rest = methods.slice(METHODS_SHOWN);
    return (
      <div key={currency} className="space-y-0.5">
        {rows.length > 1 || otherRows.length > 0 ? <p className="text-[11px] font-medium text-foreground-subtle">{currency}</p> : null}
        {shown.map((m) => (
          <div key={m.method || "none"} className="flex items-baseline justify-between gap-x-2 text-sm">
            <span className="truncate text-foreground-muted">{m.method ? paymentMethodLabel(m.method) : "No method"} <span className="text-xs">· {m.count.toLocaleString("en-US")}</span></span>
            <span className="whitespace-nowrap font-medium tabular-nums">{formatMoney(m.amountMinor, currency)}</span>
          </div>
        ))}
        {rest.length > 0 && (
          <p className="text-xs text-foreground-muted" title={rest.map((m) => `${m.method ? paymentMethodLabel(m.method) : "No method"}: ${formatMoney(m.amountMinor, currency)} (${m.count})`).join("\n")}>
            {rest.length} more: {formatMoney(rest.reduce((n, m) => n + m.amountMinor, 0), currency)}
          </p>
        )}
      </div>
    );
  };

  return (
    <div className={cn("grid grid-cols-1 gap-3 transition-opacity duration-150 sm:grid-cols-2", otherRows.length ? "xl:grid-cols-4" : "xl:grid-cols-3", refreshing && "opacity-60")} aria-busy={refreshing}>
      <Card className="space-y-1.5 p-4">
        <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-foreground-muted">Payments{refreshing && <Loader2 className="h-3 w-3 animate-spin" aria-label="Loading" />}</p>
        {waiting ? skeleton("w-12") : (
          <>
            <p className="text-lg font-semibold tabular-nums">{(summary?.count ?? 0).toLocaleString("en-US")}</p>
            {rows.length > 1 && (
              <p className="text-xs text-foreground-muted">{rows.map((g) => `${g.count.toLocaleString("en-US")} on ${g.currency} invoices`).join(" · ")}</p>
            )}
          </>
        )}
      </Card>

      <Card className="space-y-1.5 p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-foreground-muted">Received</p>
        {waiting ? skeleton("w-28") : rows.length === 0 ? (
          <p className="text-lg font-semibold text-foreground-subtle">—</p>
        ) : (
          rows.map((g: PaymentListSummaryCurrency) => {
            const away = (g.foreign ?? []).reduce((n, f) => n + f.count, 0);
            return (
              <div key={g.currency} className="flex flex-wrap items-baseline justify-between gap-x-2">
                <MoneyDisplay minor={g.amountMinor} currency={g.currency} className="whitespace-nowrap text-lg font-semibold tabular-nums text-success" />
                <span className="shrink-0 text-xs text-foreground-muted">{plural(g.count - away, "payment")}</span>
              </div>
            );
          })
        )}
      </Card>

      <Card className="space-y-2 p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-foreground-muted">By method</p>
        {waiting ? skeleton("w-36") : rows.length === 0 ? (
          <p className="text-lg font-semibold text-foreground-subtle">—</p>
        ) : (
          <>
            {rows.map((g) => g.byMethod.length > 0 && methodLines(g.currency, g.byMethod))}
            {otherRows.flatMap((g) => (g.foreign ?? []).filter((f) => f.byMethod.length > 0).map((f) => methodLines(f.currency, f.byMethod)))}
          </>
        )}
      </Card>

      {otherRows.length > 0 && (
        <Card className="space-y-1.5 border-warning/40 p-4" title="What clients actually paid in other currencies — not in Received, and never converted">
          <p className="text-xs font-medium uppercase tracking-wide text-foreground-muted">Paid in other currencies</p>
          {otherRows.map((g) => (
            <div key={g.currency}>
              {(g.foreign ?? []).filter((f) => f.count > 0).map((f) => (
                <div key={f.currency}>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                    <span className="whitespace-nowrap text-lg font-semibold tabular-nums text-warning">{formatMoney(f.amountMinor, f.currency)}</span>
                    <span className="shrink-0 text-xs text-foreground-muted">{plural(f.count, "payment")}</span>
                  </div>
                  {f.recordedMinor > 0 && <p className="text-xs text-foreground-muted">recorded as {formatMoney(f.recordedMinor, g.currency)}</p>}
                </div>
              ))}
              {(g.foreign ?? []).filter((f) => f.unknownCount > 0).map((f) => (
                <p key={`${f.currency}-unknown`} className="text-xs text-foreground-muted">
                  {plural(f.unknownCount, `${f.currency} payment`)} without the amount recorded — still in Received ({formatMoney(f.unknownMinor, g.currency)})
                </p>
              ))}
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
