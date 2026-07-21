"use client";

import { useState } from "react";
import Link from "next/link";
import { TrendingUp, DollarSign, CheckCircle, Clock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/page-header";
import { useCurrency } from "@/lib/currency-context";
import { useInvoiceSummary } from "@/features/reports/api";
import { useUsers } from "@/features/users/api";

const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => {
  const d = new Date();
  d.setDate(1);
  return d.toISOString().slice(0, 10);
};

function fmt(currency: string, minor: number) {
  return `${currency} ${(minor / 100).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

export default function SalespersonReportPage() {
  const { currency, convert } = useCurrency();
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);

  const { data, isLoading } = useInvoiceSummary(from, to, "salesperson");
  const { data: usersData } = useUsers({ pageSize: 200, sort: "name", dir: "asc" });
  const departmentByUserId = new Map(
    (usersData?.data ?? []).map((u) => [u.id, u.department?.name ?? null]),
  );

  const items = data?.items ?? [];
  const grandTotal = items.reduce((s, i) => s + i.totalMinor, 0);
  const grandPaid = items.reduce((s, i) => s + i.paidMinor, 0);
  const grandOutstanding = items.reduce((s, i) => s + i.outstandingMinor, 0);

  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        title="Salesperson Performance"
        description="Revenue, paid, and outstanding amounts by salesperson"
        icon={TrendingUp}
      />

      {/* Date range filter */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <label className="text-sm text-foreground-muted whitespace-nowrap">From</label>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="h-9 rounded-md border border-border bg-surface px-3 text-sm focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-foreground-muted whitespace-nowrap">To</label>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="h-9 rounded-md border border-border bg-surface px-3 text-sm focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
          />
        </div>
      </div>

      {/* KPI summary cards */}
      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Card key={i} className="p-5">
              <Skeleton className="h-3 w-32" />
              <Skeleton className="mt-3 h-7 w-40" />
            </Card>
          ))}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-3">
          <Card className="p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-foreground-muted flex items-center gap-1.5">
              <DollarSign className="h-3.5 w-3.5" /> Total Invoiced
            </p>
            <p className="mt-2 text-2xl font-bold font-numeric">{fmt(currency, convert(grandTotal))}</p>
            <p className="mt-1 text-xs text-foreground-subtle">{items.reduce((s, i) => s + i.count, 0)} invoices</p>
          </Card>
          <Card className="p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-foreground-muted flex items-center gap-1.5">
              <CheckCircle className="h-3.5 w-3.5" /> Paid
            </p>
            <p className="mt-2 text-2xl font-bold font-numeric text-success">{fmt(currency, convert(grandPaid))}</p>
            <p className="mt-1 text-xs text-foreground-subtle">
              {grandTotal > 0 ? Math.round((grandPaid / grandTotal) * 100) : 0}% collected
            </p>
          </Card>
          <Card className="p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-foreground-muted flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5" /> Outstanding
            </p>
            <p className="mt-2 text-2xl font-bold font-numeric text-warning">{fmt(currency, convert(grandOutstanding))}</p>
            <p className="mt-1 text-xs text-foreground-subtle">pending collection</p>
          </Card>
        </div>
      )}

      {/* Salesperson breakdown table */}
      <Card>
        <CardHeader>
          <CardTitle>By Salesperson</CardTitle>
          <CardDescription>
            {from} — {to}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-3 p-6">
              {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : items.length === 0 ? (
            <p className="py-12 text-center text-sm text-foreground-muted">
              No invoice data for this period
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-surface-muted text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                    <th className="px-4 py-3 text-left">Salesperson</th>
                    <th className="px-4 py-3 text-left">Department</th>
                    <th className="px-4 py-3 text-right">Invoices</th>
                    <th className="px-4 py-3 text-right">Invoiced</th>
                    <th className="px-4 py-3 text-right">Paid</th>
                    <th className="px-4 py-3 text-right">Outstanding</th>
                    <th className="px-4 py-3 text-right">Collected %</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((row) => {
                    const pct = row.totalMinor > 0
                      ? Math.round((row.paidMinor / row.totalMinor) * 100)
                      : 0;
                    return (
                      <tr
                        key={row.id}
                        className="border-b border-border last:border-0 hover:bg-surface-muted/50 transition-colors"
                      >
                        <td className="px-4 py-3 font-medium">
                          <Link href={`/reports/salesperson/${row.id}`} className="hover:text-primary hover:underline">
                            {row.label}
                          </Link>
                        </td>
                        <td className="px-4 py-3 text-foreground-muted">
                          {departmentByUserId.get(row.id) ?? "—"}
                        </td>
                        <td className="px-4 py-3 text-right font-numeric text-foreground-muted">{row.count}</td>
                        <td className="px-4 py-3 text-right font-numeric">{fmt(currency, convert(row.totalMinor))}</td>
                        <td className="px-4 py-3 text-right font-numeric text-success">{fmt(currency, convert(row.paidMinor))}</td>
                        <td className="px-4 py-3 text-right font-numeric text-warning">{fmt(currency, convert(row.outstandingMinor))}</td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <div className="h-1.5 w-16 rounded-full bg-surface-muted overflow-hidden">
                              <div
                                className="h-full rounded-full bg-success transition-all"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <span className="font-numeric text-xs text-foreground-muted w-8 text-right">{pct}%</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
