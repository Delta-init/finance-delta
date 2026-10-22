"use client";

import type { InvoiceListSummary, InvoiceListSummaryCurrency } from "@delta/shared";
import { Card } from "@/components/ui/card";
import { MoneyDisplay } from "@/components/ui/money";
import { cn } from "@/lib/utils";
import { useCurrency } from "@/lib/currency-context";

/**
 * The Invoices list's cards (the user, 2026-10-22: "stat cards like the expenses, with the filters' effect"): what the
 * filters match — how many, and their money (invoiced, paid, still owed, overdue) a line per currency, never added
 * together. From the server with the table's own filters, so the two always agree. Drafts and voided invoices are
 * counted but are not money.
 */
export function InvoiceSummaryCards({ summary, loading }: { summary: InvoiceListSummary | undefined; loading: boolean }) {
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

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      <Card className="space-y-1.5 p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-foreground-muted">Invoices</p>
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
      {money("Paid", (g) => g.paidMinor, (g) => g.paidCount, "text-success")}
      {money("Balance due", (g) => g.balanceMinor, (g) => g.balanceCount)}
      {money("Overdue", (g) => g.overdueMinor, (g) => g.overdueCount, "text-danger")}
    </div>
  );
}
