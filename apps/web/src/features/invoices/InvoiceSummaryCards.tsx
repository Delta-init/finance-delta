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
 * What was paid in rupees has a card of its own (the user, 2026-11-13: "separate INR stats card … no need to convert
 * anywhere"): the rupees as they were paid, and Paid without them. A rupee payment whose rupees were never recorded
 * stays in Paid, and the card says how many there are.
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

  // Rupees paid on invoices in another currency: a line for each such currency (there is one in practice).
  const rupeeRows = rows.filter((g) => g.currency !== "INR" && ((g.inrCount ?? 0) > 0 || (g.inrUnknownCount ?? 0) > 0));

  return (
    <div className={cn("grid grid-cols-2 gap-3 transition-opacity duration-150 md:grid-cols-3", rupeeRows.length ? "xl:grid-cols-6" : "xl:grid-cols-5", refreshing && "opacity-60")} aria-busy={refreshing}>
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
      {money("Paid", (g) => g.paidMinor - (g.inrRecordedMinor ?? 0), (g) => g.paidCount, "text-success")}
      {rupeeRows.length > 0 && (
        <Card className="space-y-1.5 border-warning/40 p-4" title="The rupees clients actually paid — not in Paid, and never converted">
          <p className="text-xs font-medium uppercase tracking-wide text-foreground-muted">Paid in INR</p>
          {rupeeRows.map((g) => (
            <div key={g.currency}>
              <p className="whitespace-nowrap text-lg font-semibold tabular-nums text-warning">{(g.inrCount ?? 0) > 0 ? formatMoney(g.inrMinor ?? 0, "INR") : "—"}</p>
              {(g.inrCount ?? 0) > 0 && (
                <p className="text-xs text-foreground-muted">
                  {(g.inrCount ?? 0).toLocaleString("en-US")} {g.inrCount === 1 ? "invoice" : "invoices"} · recorded as {formatMoney(g.inrRecordedMinor ?? 0, g.currency)}
                </p>
              )}
              {(g.inrUnknownCount ?? 0) > 0 && (
                <p className="text-xs text-foreground-muted">
                  {g.inrUnknownCount} rupee payment{g.inrUnknownCount === 1 ? "" : "s"} without the rupees recorded — still in Paid ({formatMoney(g.inrUnknownMinor ?? 0, g.currency)})
                </p>
              )}
            </div>
          ))}
        </Card>
      )}
      {money("Balance due", (g) => g.balanceMinor, (g) => g.balanceCount)}
      {money("Overdue", (g) => g.overdueMinor, (g) => g.overdueCount, "text-danger")}
    </div>
  );
}
