"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { formatMoney, type PspAccountSummary } from "@delta/shared";
import { AlertTriangle, ArrowRight, CreditCard } from "lucide-react";
import { api } from "@/lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/*
 * Unsettled PSP money (the user, 2026-11-06): what Tabby, Tamara, a card acquirer… still hold for us — clients' payments
 * the provider hasn't paid on to the bank yet — per PSP account, with the fee it should cost and what's past the
 * account's settlement days. Each row opens the account, where the settlement is recorded. Shows nothing when there are
 * no PSP accounts, or against an API without the endpoint.
 */

const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Asia/Dubai" });

export function PspUnsettledCard() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["bank-accounts", "psp", "all-summary"],
    queryFn: () => api.get<PspAccountSummary[]>("bank-accounts/psp/summary"),
    retry: false,
    staleTime: 60_000,
  });

  if (isError || (!isLoading && !data?.length)) return null;

  // Totals per currency — a dirham PSP and a rupee PSP don't add up.
  const totals = new Map<string, { unsettled: number; fee: number; late: number; count: number }>();
  for (const a of data ?? []) {
    const t = totals.get(a.currency) ?? { unsettled: 0, fee: 0, late: 0, count: 0 };
    t.unsettled += a.unsettledMinor; t.fee += a.expectedFeeMinor; t.late += a.lateMinor; t.count += a.unsettledCount;
    totals.set(a.currency, t);
  }

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2"><CreditCard className="h-4 w-4 text-warning" />Unsettled PSP money</CardTitle>
          <CardDescription>Client payments a provider still holds — not in the bank yet</CardDescription>
        </div>
        {isLoading ? <Skeleton className="h-8 w-32" /> : (
          <div className="flex flex-wrap gap-4 text-right">
            {[...totals].map(([cur, t]) => (
              <div key={cur}>
                <div className="text-lg font-semibold tabular-nums">{formatMoney(t.unsettled, cur)}</div>
                <div className="text-xs text-foreground-muted">
                  {t.count} payment{t.count === 1 ? "" : "s"} · fee ≈ {formatMoney(t.fee, cur)}
                  {t.late > 0 && <span className="text-danger"> · {formatMoney(t.late, cur)} late</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">{Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
        ) : (
          <div className="divide-y divide-border rounded-lg border border-border">
            {data!.map((a) => (
              <Link key={a.accountId} href={`/banking/${a.accountId}`}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2.5 text-sm hover:bg-surface-muted/60">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{a.provider || a.accountName}</div>
                  <div className="truncate text-xs text-foreground-muted">
                    {a.provider && a.provider !== a.accountName ? `${a.accountName} · ` : ""}settles into {a.settlementAccountName || "—"}
                    {a.oldestDate ? ` · oldest ${day(a.oldestDate)}` : ""}
                  </div>
                </div>
                {a.unsettledCount === 0 ? (
                  <span className="text-xs text-success">All settled</span>
                ) : (
                  <div className="text-right">
                    <div className="font-semibold tabular-nums">{formatMoney(a.unsettledMinor, a.currency)}</div>
                    <div className="text-xs text-foreground-muted">
                      {a.unsettledCount} payment{a.unsettledCount === 1 ? "" : "s"} · fee ≈ {formatMoney(a.expectedFeeMinor, a.currency)}
                    </div>
                  </div>
                )}
                {a.lateCount > 0 && (
                  <span className="inline-flex items-center gap-1 rounded-md bg-danger/10 px-2 py-0.5 text-xs font-medium text-danger">
                    <AlertTriangle className="h-3 w-3" />{a.lateCount} late · {formatMoney(a.lateMinor, a.currency)}
                  </span>
                )}
                <ArrowRight className="h-4 w-4 shrink-0 text-foreground-muted" />
              </Link>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
