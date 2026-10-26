"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ApiError } from "@/lib/api";
import { useCurrency } from "@/lib/currency-context";
import { Breakdown } from "@/features/reports/DailyBreakdownDialog";
import { useDashboardBreakdown, type DashboardBreakdownParams } from "./api";

/**
 * What was clicked on the dashboard (the user, 2026-10-26: "breakdown of the stat and graph and all"). A figure that
 * is two others side by side — net profit (revenue, expenses), a cash flow month (money in, money out) — lists both.
 */
export type DashboardPick = { label: string; parts: DashboardBreakdownParams[] };

const Ctx = createContext<(pick: DashboardPick) => void>(() => {});

/** Lets any dashboard card or chart open the breakdown of what it shows. */
export function useOpenBreakdown() {
  return useContext(Ctx);
}

export function DashboardBreakdownProvider({ children }: { children: ReactNode }) {
  const [pick, setPick] = useState<DashboardPick | null>(null);
  const { currency, convert } = useCurrency();
  const money = (minor: number) =>
    `${currency} ${(convert(minor) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return (
    <Ctx.Provider value={setPick}>
      {children}
      <Dialog open={!!pick} onOpenChange={(o) => { if (!o) setPick(null); }}>
        <DialogContent className="max-h-[88vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{pick?.label}</DialogTitle>
            <DialogDescription>Where the figure comes from — click a group to see only its records, a record to open it.</DialogDescription>
          </DialogHeader>
          <div className={pick && pick.parts.length > 1 ? "grid gap-6 lg:grid-cols-2" : ""}>
            {pick?.parts.map((p) => <Part key={JSON.stringify(p)} params={p} money={money} showTitle={pick.parts.length > 1} />)}
          </div>
        </DialogContent>
      </Dialog>
    </Ctx.Provider>
  );
}

function Part({ params, money, showTitle }: { params: DashboardBreakdownParams; money: (m: number) => string; showTitle: boolean }) {
  const { data, isLoading, error } = useDashboardBreakdown(params);
  if (isLoading) return <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-foreground-muted" /></div>;
  if (error || !data) {
    return (
      <p className="py-10 text-center text-sm text-foreground-muted">
        {error instanceof ApiError && error.status === 404
          ? "This needs the latest finance API — ask for it to be updated."
          : error instanceof ApiError ? error.message : "Could not load it."}
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-xs text-foreground-muted">{showTitle ? <span className="font-semibold text-foreground">{data.title} · </span> : null}{data.scope}</p>
      <Breakdown data={data} money={money} />
    </div>
  );
}

/** This month and last (YYYY-MM, Dubai) — from the API, or worked out here when it is older than 2026-10-26. */
export function dashboardMonths(months?: { current: string; last: string }): { current: string; last: string } {
  if (months) return months;
  const d = new Date(Date.now() + 4 * 60 * 60 * 1000);
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  const key = (yy: number, mm: number) => { const t = new Date(Date.UTC(yy, mm, 1)); return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}`; };
  return { current: key(y, m), last: key(y, m - 1) };
}

/** "October 2026" from "2026-10". */
export function monthTitle(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, 1)).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
}
