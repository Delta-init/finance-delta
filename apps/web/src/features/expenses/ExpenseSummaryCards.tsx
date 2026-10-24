"use client";

import type { ExpenseSummary, ExpenseSummaryCurrency } from "@delta/shared";
import { Loader2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { MoneyDisplay } from "@/components/ui/money";
import { cn } from "@/lib/utils";
import { useCurrency } from "@/lib/currency-context";

/**
 * The Expenses list's cards (the user, 2026-10-21): what the filters match — how many, and their money
 * (total, paid, unpaid, overdue) a line per currency, never added together. The figures come from the
 * server with the table's own filters, so the two always agree.
 */
export function ExpenseSummaryCards({ summary, loading, refreshing = false }: { summary: ExpenseSummary | undefined; loading: boolean; /** The last filters' figures, while the new ones load (2026-10-24). */ refreshing?: boolean }) {
  const { baseCurrency } = useCurrency();
  if (!summary && !loading) return null;
  // The organization's own currency first, then the others by how many — the same order on every card.
  const rows = [...(summary?.byCurrency ?? [])].sort((a, b) =>
    a.currency === baseCurrency ? -1 : b.currency === baseCurrency ? 1 : b.count - a.count || a.currency.localeCompare(b.currency));
  const money = (label: string, amount: (g: ExpenseSummaryCurrency) => number, count?: (g: ExpenseSummaryCurrency) => number, tone?: string) => (
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
            {count && <span className="shrink-0 text-xs text-foreground-muted">{count(g).toLocaleString("en-US")} {count(g) === 1 ? "expense" : "expenses"}</span>}
          </div>
        ))
      )}
    </Card>
  );

  return (
    <div className={cn("grid grid-cols-2 gap-3 transition-opacity duration-150 md:grid-cols-3 xl:grid-cols-5", refreshing && "opacity-60")} aria-busy={refreshing}>
      <Card className="space-y-1.5 p-4">
        <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-foreground-muted">Expenses{refreshing && <Loader2 className="h-3 w-3 animate-spin" aria-label="Loading" />}</p>
        {loading && !summary ? (
          <div className="h-6 w-12 animate-pulse rounded bg-surface-muted" />
        ) : (
          <>
            <p className="text-lg font-semibold tabular-nums">{(summary?.count ?? 0).toLocaleString("en-US")}</p>
            {rows.length > 1 && (
              <p className="text-xs text-foreground-muted">{rows.map((g) => `${g.count.toLocaleString("en-US")} ${g.currency}`).join(" · ")}</p>
            )}
            {!!summary?.leftOut && (
              <p className="text-xs text-foreground-muted">{summary.leftOut} voided/rejected not in the amounts</p>
            )}
          </>
        )}
      </Card>
      {money("Total", (g) => g.totalMinor, (g) => g.count)}
      {money("Paid", (g) => g.paidMinor, (g) => g.paidCount, "text-success")}
      {money("Unpaid", (g) => g.unpaidMinor, (g) => g.unpaidCount)}
      {money("Overdue", (g) => g.overdueMinor, (g) => g.overdueCount, "text-danger")}
    </div>
  );
}
