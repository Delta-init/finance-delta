"use client";

import { formatMoney, type InvoiceListSummary, type InvoiceListSummaryCurrency } from "@delta/shared";
import { Loader2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { MoneyDisplay } from "@/components/ui/money";
import { cn } from "@/lib/utils";
import { useCurrency } from "@/lib/currency-context";

/**
 * The Invoices list's cards (the user, 2026-10-22: "stat cards like the expenses, with the filters' effect"): what the
 * filters match — how many, and their money (invoiced, paid, still owed, overdue) a line per currency, never added
 * together. From the server with the table's own filters, so the two always agree. Drafts and voided invoices are
 * counted but are not money.
 *
 * What was paid in other currencies has a card of its own (the user, 2026-11-13: "separate INR stats card … whichever
 * currency they are giving … no need to convert anywhere"): a line for each as it was paid, and Paid without them. A
 * payment in another currency whose amount was never recorded stays in Paid, and the card says how many there are.
 */
export function InvoiceSummaryCards({ summary, loading, refreshing = false }: { summary: InvoiceListSummary | undefined; loading: boolean; /** The last filters' figures, while the new ones load (2026-10-24). */ refreshing?: boolean }) {
  const { baseCurrency } = useCurrency();
  if (!summary && !loading) return null;
  // The organization's own currency first, then the others by how many — the same order on every card.
  const rows = [...(summary?.byCurrency ?? [])].sort((a, b) =>
    a.currency === baseCurrency ? -1 : b.currency === baseCurrency ? 1 : b.count - a.count || a.currency.localeCompare(b.currency));
  const money = (label: string, amount: (g: InvoiceListSummaryCurrency) => number, count?: (g: InvoiceListSummaryCurrency) => number, tone?: string) => (
    <Card className="space-y-1.5 p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-foreground-muted">{label}</p>
      {loading && !summary ? (
        <div className="h-6 w-28 animate-pulse rounded bg-surface-muted" />
      ) : rows.length === 0 ? (
        <p className="text-lg font-semibold text-foreground-subtle">—</p>
      ) : (
        rows.map((g) => (
          <div key={g.currency} className="flex flex-wrap items-baseline justify-between gap-x-2">
            <MoneyDisplay minor={amount(g)} currency={g.currency} className={cn("whitespace-nowrap text-lg font-semibold tabular-nums", tone)} />
            {count && <span className="shrink-0 text-xs text-foreground-muted">{count(g).toLocaleString("en-US")} {count(g) === 1 ? "invoice" : "invoices"}</span>}
          </div>
        ))
      )}
    </Card>
  );

  // What was paid in other currencies, on the invoices of each currency (there is one in practice).
  const otherRows = rows.filter((g) => (g.foreign ?? []).length > 0);
  const recordedOf = (g: InvoiceListSummaryCurrency) => (g.foreign ?? []).reduce((n, f) => n + f.recordedMinor, 0);

  return (
    <div className={cn("grid grid-cols-2 gap-3 transition-opacity duration-150 md:grid-cols-3", otherRows.length ? "xl:grid-cols-6" : "xl:grid-cols-5", refreshing && "opacity-60")} aria-busy={refreshing}>
      <Card className="space-y-1.5 p-4">
        <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-foreground-muted">Invoices{refreshing && <Loader2 className="h-3 w-3 animate-spin" aria-label="Loading" />}</p>
        {loading && !summary ? (
          <div className="h-6 w-12 animate-pulse rounded bg-surface-muted" />
        ) : (
          <>
            <p className="text-lg font-semibold tabular-nums">{(summary?.count ?? 0).toLocaleString("en-US")}</p>
            {rows.length > 1 && (
              <p className="text-xs text-foreground-muted">{rows.map((g) => `${g.count.toLocaleString("en-US")} ${g.currency}`).join(" · ")}</p>
            )}
            {!!summary?.leftOut && (
              <p className="text-xs text-foreground-muted">{summary.leftOut} draft/voided not in the amounts</p>
            )}
          </>
        )}
      </Card>
      {money("Invoiced", (g) => g.totalMinor, (g) => g.count)}
      {money("Paid", (g) => g.paidMinor - recordedOf(g), (g) => g.paidCount, "text-success")}
      {otherRows.length > 0 && (
        <Card className="space-y-1.5 border-warning/40 p-4" title="What clients actually paid in other currencies — not in Paid, and never converted">
          <p className="text-xs font-medium uppercase tracking-wide text-foreground-muted">Paid in other currencies</p>
          {otherRows.map((g) => (
            <div key={g.currency}>
              {(g.foreign ?? []).filter((f) => f.count > 0).map((f) => (
                <div key={f.currency} className="flex flex-wrap items-baseline justify-between gap-x-2">
                  <span className="whitespace-nowrap text-lg font-semibold tabular-nums text-warning">{formatMoney(f.amountMinor, f.currency)}</span>
                  <span className="shrink-0 text-xs text-foreground-muted">{f.count.toLocaleString("en-US")} {f.count === 1 ? "invoice" : "invoices"}</span>
                </div>
              ))}
              {recordedOf(g) > 0 && <p className="text-xs text-foreground-muted">recorded as {formatMoney(recordedOf(g), g.currency)}</p>}
              {(g.foreign ?? []).filter((f) => f.unknownCount > 0).map((f) => (
                <p key={f.currency} className="text-xs text-foreground-muted">
                  {f.unknownCount} {f.currency} payment{f.unknownCount === 1 ? "" : "s"} without the amount recorded — still in Paid ({formatMoney(f.unknownMinor, g.currency)})
                </p>
              ))}
            </div>
          ))}
        </Card>
      )}
      {money("Balance due", (g) => g.balanceMinor, (g) => g.balanceCount)}
      {money("Overdue", (g) => g.overdueMinor, (g) => g.overdueCount, "text-danger")}
    </div>
  );
}
