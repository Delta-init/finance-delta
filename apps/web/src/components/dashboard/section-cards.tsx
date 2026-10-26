"use client";

import { DollarSign, Clock, CreditCard, TrendingUp, TrendingDown } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useDashboardStats } from "@/features/dashboard/api";
import { useCurrency } from "@/lib/currency-context";
import { dashboardMonths, monthTitle, useOpenBreakdown, type DashboardPick } from "@/features/dashboard/DashboardBreakdown";

function fmt(currency: string, minor: number) {
  return `${currency} ${(minor / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

export function SectionCards() {
  const { data, isLoading } = useDashboardStats();
  const { currency, convert } = useCurrency();
  const open = useOpenBreakdown();

  if (isLoading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="p-5">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="mt-3 h-7 w-40" />
            <Skeleton className="mt-3 h-5 w-24" />
          </Card>
        ))}
      </div>
    );
  }

  if (!data) return null;

  const { kpi } = data;
  const { current } = dashboardMonths(data.months);
  const month = monthTitle(current);

  const revenueTrend = kpi.revenueTrend;
  const profitTrend = kpi.netProfitLastMonth > 0
    ? Math.round(((kpi.netProfitMtd - kpi.netProfitLastMonth) / kpi.netProfitLastMonth) * 100)
    : 0;

  const cards = [
    {
      label: "Revenue MTD",
      value: fmt(currency, convert(kpi.revenueMtd)),
      trend: revenueTrend >= 0 ? "up" as const : "down" as const,
      pct: Math.abs(revenueTrend),
      hint: "vs last month",
      Icon: DollarSign,
      pick: { label: `Revenue — ${month}`, parts: [{ kind: "revenue", month: current }] } as DashboardPick,
      extra: null as null | { text: string; pick: DashboardPick },
    },
    {
      label: "Outstanding Receivables",
      value: fmt(currency, convert(kpi.receivables)),
      trend: null,
      pct: null,
      hint: "",
      Icon: Clock,
      pick: { label: "Outstanding receivables", parts: [{ kind: "receivables" }] } as DashboardPick,
      // Its own link: the overdue ones alone.
      extra: { text: `${kpi.overdueCount} overdue · ${fmt(currency, convert(kpi.overdueAmount))}`, pick: { label: "Overdue invoices", parts: [{ kind: "overdue" }] } as DashboardPick },
    },
    {
      label: "Outstanding Payables",
      value: fmt(currency, convert(kpi.payables)),
      trend: null,
      pct: null,
      // Bills and approved expenses not paid yet (2026-10-26).
      hint: kpi.payablesBills !== undefined && kpi.payablesExpenses !== undefined
        ? `bills ${fmt(currency, convert(kpi.payablesBills))} · unpaid expenses ${fmt(currency, convert(kpi.payablesExpenses))}`
        : "total owed",
      Icon: CreditCard,
      pick: { label: "Outstanding payables", parts: [{ kind: "payables" }] } as DashboardPick,
      extra: null,
    },
    {
      label: "Net Profit MTD",
      value: fmt(currency, convert(kpi.netProfitMtd)),
      trend: profitTrend >= 0 ? "up" as const : "down" as const,
      pct: Math.abs(profitTrend),
      hint: "vs last month",
      Icon: TrendingUp,
      pick: { label: `Net profit — ${month}: revenue less expenses`, parts: [{ kind: "revenue", month: current }, { kind: "expenses", month: current }] } as DashboardPick,
      extra: null,
    },
  ];

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map((card) => (
        <Card
          key={card.label}
          role="button"
          tabIndex={0}
          title="See where this comes from"
          onClick={() => open(card.pick)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(card.pick); } }}
          className="p-5 relative overflow-hidden cursor-pointer transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <p className="text-xs font-medium uppercase tracking-wider text-foreground-muted">{card.label}</p>
          <p className="mt-2 text-2xl font-bold tracking-tight font-numeric">{card.value}</p>
          <div className="mt-2 flex items-center gap-2">
            {card.trend !== null && card.pct !== null ? (
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
                  card.trend === "up" ? "bg-success/10 text-success" : "bg-danger/10 text-danger",
                )}
              >
                {card.trend === "up" ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                {card.trend === "up" ? "+" : "-"}{card.pct}%
              </span>
            ) : null}
            {card.hint && <span className="text-xs text-foreground-subtle">{card.hint}</span>}
            {card.extra && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); open(card.extra!.pick); }}
                onKeyDown={(e) => e.stopPropagation()}
                className="relative z-10 text-xs text-foreground-subtle underline-offset-2 hover:text-primary hover:underline"
              >
                {card.extra.text}
              </button>
            )}
          </div>
          <card.Icon className="absolute right-4 bottom-3 h-16 w-16 text-foreground/[0.04]" />
        </Card>
      ))}
    </div>
  );
}
