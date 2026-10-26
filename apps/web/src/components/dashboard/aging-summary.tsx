"use client";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useDashboardStats } from "@/features/dashboard/api";
import { useCurrency } from "@/lib/currency-context";
import { useOpenBreakdown } from "@/features/dashboard/DashboardBreakdown";
import type { AgingBand } from "@delta/shared";

interface Band {
  label: string;
  key: keyof {
    current: number;
    band1to30: number;
    band31to60: number;
    band61to90: number;
    band90plus: number;
    total: number;
  };
  barColor: string;
  textColor: string;
  /** The band the breakdown asks for (2026-10-26). */
  band: AgingBand;
}

const BANDS: Band[] = [
  { label: "Current", key: "current", band: "current", barColor: "bg-success", textColor: "text-success" },
  { label: "1–30 days", key: "band1to30", band: "1-30", barColor: "bg-warning", textColor: "text-warning" },
  { label: "31–60 days", key: "band31to60", band: "31-60", barColor: "bg-orange-500", textColor: "text-orange-500" },
  { label: "61–90 days", key: "band61to90", band: "61-90", barColor: "bg-orange-700", textColor: "text-orange-700" },
  { label: "90+ days", key: "band90plus", band: "90+", barColor: "bg-danger", textColor: "text-danger" },
];

export function AgingSummary() {
  const { data, isLoading } = useDashboardStats();

  const { currency, convert } = useCurrency();
  const open = useOpenBreakdown();
  const aging = data?.aging;
  const total = aging?.total ?? 0;

  function fmtAmount(minor: number) {
    return `${currency} ${(convert(minor) / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Receivables Aging</CardTitle>
        <CardDescription>Outstanding amounts by overdue period</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading
          ? Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Skeleton className="h-3.5 w-20" />
                  <Skeleton className="h-3.5 w-24" />
                </div>
                <Skeleton className="h-2 w-full rounded-full" />
              </div>
            ))
          : aging
          ? (
            <>
              {BANDS.map((band) => {
                const value = aging[band.key] as number;
                const pct = total > 0 ? (value / total) * 100 : 0;
                return (
                  <button
                    key={band.key}
                    type="button"
                    onClick={() => open({ label: `Receivables — ${band.label}`, parts: [{ kind: "aging", band: band.band }] })}
                    className="block w-full space-y-1.5 rounded-md text-left hover:bg-surface-muted/60"
                    title="See these invoices"
                  >
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-foreground-muted">{band.label}</span>
                      <span className={`font-numeric font-medium text-xs ${band.textColor}`}>
                        {fmtAmount(value)}
                      </span>
                    </div>
                    <div className="h-2 w-full rounded-full bg-surface-muted overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${band.barColor}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => open({ label: "Outstanding receivables", parts: [{ kind: "receivables" }] })}
                className="flex w-full items-center justify-between border-t border-border pt-3 text-sm font-semibold hover:text-primary"
              >
                <span>Total</span>
                <span className="font-numeric">{fmtAmount(total)}</span>
              </button>
            </>
          )
          : (
            <p className="text-sm text-foreground-muted text-center py-4">No aging data available</p>
          )}
      </CardContent>
    </Card>
  );
}
