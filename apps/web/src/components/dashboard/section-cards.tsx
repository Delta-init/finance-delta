"use client";

import { DollarSign, Clock, CreditCard, TrendingUp, TrendingDown } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useDashboardStats } from "@/features/dashboard/api";
import { useCurrency } from "@/lib/currency-context";

function fmt(currency: string, minor: number) {
  return `${currency} ${(minor / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

export function SectionCards() {
  const { data, isLoading } = useDashboardStats();
  const { currency, convert } = useCurrency();

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
    },
    {
      label: "Outstanding Receivables",
      value: fmt(currency, convert(kpi.receivables)),
      trend: null,
      pct: null,
      hint: `${kpi.overdueCount} overdue`,
      Icon: Clock,
    },
    {
      label: "Outstanding Payables",
      value: fmt(currency, convert(kpi.payables)),
      trend: null,
      pct: null,
      hint: "total owed",
      Icon: CreditCard,
    },
    {
      label: "Net Profit MTD",
      value: fmt(currency, convert(kpi.netProfitMtd)),
      trend: profitTrend >= 0 ? "up" as const : "down" as const,
      pct: Math.abs(profitTrend),
      hint: "vs last month",
      Icon: TrendingUp,
    },
  ];

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map((card) => (
        <Card key={card.label} className="p-5 relative overflow-hidden">
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
            <span className="text-xs text-foreground-subtle">{card.hint}</span>
          </div>
          <card.Icon className="absolute right-4 bottom-3 h-16 w-16 text-foreground/[0.04]" />
        </Card>
      ))}
    </div>
  );
}
