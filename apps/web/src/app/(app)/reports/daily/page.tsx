"use client";

import { useState } from "react";
import { CalendarDays, TrendingUp, TrendingDown, DollarSign, Wallet } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/page-header";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCurrency } from "@/lib/currency-context";
import { useDailyReport } from "@/features/reports/api";
import { useAllDepartments } from "@/features/departments/api";

const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => {
  const d = new Date();
  d.setDate(1);
  return d.toISOString().slice(0, 10);
};

const ALL = "__all";

function fmt(currency: string, minor: number) {
  return `${currency} ${(minor / 100).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

export default function DailyReportPage() {
  const { currency, convert } = useCurrency();
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const [departmentId, setDepartmentId] = useState(ALL);

  const { data: departments } = useAllDepartments();
  const { data, isLoading } = useDailyReport(
    from,
    to,
    departmentId === ALL ? undefined : departmentId,
  );

  const rows = data?.rows ?? [];
  const totals = data?.totals ?? { incomeMinor: 0, expenseMinor: 0, revenueMinor: 0, netMinor: 0 };

  const kpis = [
    { label: "Income", value: totals.incomeMinor, Icon: DollarSign, className: "text-success" },
    { label: "Expenses", value: totals.expenseMinor, Icon: Wallet, className: "text-danger" },
    { label: "Revenue (Invoiced)", value: totals.revenueMinor, Icon: TrendingUp, className: "text-foreground" },
    {
      label: "Net (Income − Expenses)",
      value: totals.netMinor,
      Icon: totals.netMinor >= 0 ? TrendingUp : TrendingDown,
      className: totals.netMinor >= 0 ? "text-success" : "text-danger",
    },
  ];

  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        title="Daily Report"
        description="Income received, expenses, and invoiced revenue per day"
        icon={CalendarDays}
      />

      {/* Filters */}
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
        {(departments?.length ?? 0) > 0 && (
          <Select value={departmentId} onValueChange={setDepartmentId}>
            <SelectTrigger className="w-[190px]">
              <SelectValue placeholder="All departments" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All departments</SelectItem>
              {departments?.map((d) => (
                <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {departmentId !== ALL && (
          <span className="text-xs text-foreground-subtle">
            Income & revenue scoped to this department; expenses are org-wide.
          </span>
        )}
      </div>

      {/* KPI cards */}
      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Card key={i} className="p-5">
              <Skeleton className="h-3 w-28" />
              <Skeleton className="mt-3 h-7 w-36" />
            </Card>
          ))}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {kpis.map(({ label, value, Icon, className }) => (
            <Card key={label} className="p-5">
              <p className="text-xs font-medium uppercase tracking-wider text-foreground-muted flex items-center gap-1.5">
                <Icon className="h-3.5 w-3.5" /> {label}
              </p>
              <p className={`mt-2 text-2xl font-bold font-numeric ${className}`}>
                {fmt(currency, convert(value))}
              </p>
            </Card>
          ))}
        </div>
      )}

      {/* Daily table */}
      <Card>
        <CardHeader>
          <CardTitle>Day by Day</CardTitle>
          <CardDescription>
            {from} — {to}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-3 p-6">
              {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : rows.length === 0 ? (
            <p className="py-12 text-center text-sm text-foreground-muted">
              No activity in this period
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-surface-muted text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                    <th className="px-4 py-3 text-left">Date</th>
                    <th className="px-4 py-3 text-right">Income</th>
                    <th className="px-4 py-3 text-right">Expenses</th>
                    <th className="px-4 py-3 text-right">Revenue (Invoiced)</th>
                    <th className="px-4 py-3 text-right">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr
                      key={r.date}
                      className="border-b border-border last:border-0 hover:bg-surface-muted/50 transition-colors"
                    >
                      <td className="px-4 py-3 font-medium">{r.date}</td>
                      <td className="px-4 py-3 text-right font-numeric text-success">
                        {r.incomeMinor ? fmt(currency, convert(r.incomeMinor)) : "—"}
                      </td>
                      <td className="px-4 py-3 text-right font-numeric text-danger">
                        {r.expenseMinor ? fmt(currency, convert(r.expenseMinor)) : "—"}
                      </td>
                      <td className="px-4 py-3 text-right font-numeric">
                        {r.revenueMinor ? fmt(currency, convert(r.revenueMinor)) : "—"}
                      </td>
                      <td className={`px-4 py-3 text-right font-numeric font-semibold ${r.netMinor >= 0 ? "text-success" : "text-danger"}`}>
                        {fmt(currency, convert(r.netMinor))}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-border bg-surface-muted/50 font-semibold">
                    <td className="px-4 py-3">Total</td>
                    <td className="px-4 py-3 text-right font-numeric text-success">{fmt(currency, convert(totals.incomeMinor))}</td>
                    <td className="px-4 py-3 text-right font-numeric text-danger">{fmt(currency, convert(totals.expenseMinor))}</td>
                    <td className="px-4 py-3 text-right font-numeric">{fmt(currency, convert(totals.revenueMinor))}</td>
                    <td className={`px-4 py-3 text-right font-numeric ${totals.netMinor >= 0 ? "text-success" : "text-danger"}`}>
                      {fmt(currency, convert(totals.netMinor))}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
