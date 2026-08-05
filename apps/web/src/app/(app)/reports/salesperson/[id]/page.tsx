"use client";

import { use, useState } from "react";
import Link from "next/link";
import { ArrowLeft, TrendingUp, DollarSign, CheckCircle, Clock, FileText } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { MoneyDisplay } from "@/components/ui/money";
import { useCurrency } from "@/lib/currency-context";
import { useInvoiceSummary } from "@/features/reports/api";
import { useCommissionRecords } from "@/features/commissions/api";
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

const STATUS_TONE: Record<string, "success" | "warning" | "neutral" | "danger"> = {
  earned: "warning",
  paid: "success",
  cancelled: "neutral",
};

export default function SalespersonDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { currency, convert } = useCurrency();
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);

  const { data: usersData } = useUsers({ pageSize: 100, sort: "name", dir: "asc" });
  const { data: summary, isLoading: summaryLoading } = useInvoiceSummary(from, to, "salesperson");
  const { data: commissions, isLoading: commissionsLoading } = useCommissionRecords({
    salespersonId: id,
    from,
    to,
    pageSize: 50,
  });

  const salesperson = usersData?.data.find((u) => u.id === id);
  const salespersonName = salesperson?.name ?? summary?.items.find((i) => i.id === id)?.label ?? "Salesperson";
  const summaryItem = summary?.items.find((i) => i.id === id);

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link
          href="/reports/salesperson"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-foreground-muted transition-colors hover:bg-surface-muted hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{salespersonName}</h1>
          <p className="text-sm text-foreground-muted">
            Salesperson performance detail
            {salesperson?.department?.name ? ` · ${salesperson.department.name}` : ""}
          </p>
        </div>
      </div>

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

      {/* KPI cards */}
      {summaryLoading ? (
        <div className="grid gap-4 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Card key={i} className="p-5">
              <Skeleton className="h-3 w-28" />
              <Skeleton className="mt-3 h-7 w-36" />
            </Card>
          ))}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-4">
          <Card className="p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-foreground-muted flex items-center gap-1.5">
              <FileText className="h-3.5 w-3.5" /> Invoices
            </p>
            <p className="mt-2 text-2xl font-bold font-numeric">{summaryItem?.count ?? 0}</p>
            <p className="mt-1 text-xs text-foreground-subtle">total raised</p>
          </Card>
          <Card className="p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-foreground-muted flex items-center gap-1.5">
              <DollarSign className="h-3.5 w-3.5" /> Invoiced
            </p>
            <p className="mt-2 text-2xl font-bold font-numeric">
              {fmt(currency, convert(summaryItem?.totalMinor ?? 0))}
            </p>
            <p className="mt-1 text-xs text-foreground-subtle">total value</p>
          </Card>
          <Card className="p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-foreground-muted flex items-center gap-1.5">
              <CheckCircle className="h-3.5 w-3.5" /> Paid
            </p>
            <p className="mt-2 text-2xl font-bold font-numeric text-success">
              {fmt(currency, convert(summaryItem?.paidMinor ?? 0))}
            </p>
            <p className="mt-1 text-xs text-foreground-subtle">
              {summaryItem && summaryItem.totalMinor > 0
                ? `${Math.round((summaryItem.paidMinor / summaryItem.totalMinor) * 100)}% collected`
                : "—"}
            </p>
          </Card>
          <Card className="p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-foreground-muted flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5" /> Outstanding
            </p>
            <p className="mt-2 text-2xl font-bold font-numeric text-warning">
              {fmt(currency, convert(summaryItem?.outstandingMinor ?? 0))}
            </p>
            <p className="mt-1 text-xs text-foreground-subtle">pending collection</p>
          </Card>
        </div>
      )}

      {/* Commission records */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4" /> Commission Records
          </CardTitle>
          <CardDescription>Auto-calculated commission entries for {salespersonName}</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {commissionsLoading ? (
            <div className="space-y-3 p-6">
              {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : !commissions?.data.length ? (
            <p className="py-12 text-center text-sm text-foreground-muted">
              No commission records for this period
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-surface-muted text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                    <th className="px-4 py-3 text-left">Invoice</th>
                    <th className="px-4 py-3 text-left">Trigger</th>
                    <th className="px-4 py-3 text-right">Invoice Total</th>
                    <th className="px-4 py-3 text-right">Commission</th>
                    <th className="px-4 py-3 text-left">Status</th>
                    <th className="px-4 py-3 text-left">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {commissions.data.map((r) => (
                    <tr
                      key={r.id}
                      className="border-b border-border last:border-0 hover:bg-surface-muted/50 transition-colors"
                    >
                      <td className="px-4 py-3 font-mono text-sm">{r.invoiceNumber}</td>
                      <td className="px-4 py-3 text-foreground-muted text-xs">
                        {r.basis === "invoice_raised" ? "Invoice raised" : "Payment received"}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <MoneyDisplay minor={r.invoiceTotalMinor} />
                      </td>
                      <td className="px-4 py-3 text-right">
                        <MoneyDisplay minor={r.commissionMinor} className="font-semibold" />
                      </td>
                      <td className="px-4 py-3">
                        <Badge tone={STATUS_TONE[r.status]} className="capitalize">{r.status}</Badge>
                      </td>
                      <td className="px-4 py-3 text-foreground-muted text-xs">
                        {new Date(r.calculatedAt).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-border bg-surface-muted/50">
                    <td colSpan={3} className="px-4 py-2 text-xs text-foreground-muted font-medium">
                      Total ({commissions.data.length} records)
                    </td>
                    <td className="px-4 py-2 text-right">
                      <MoneyDisplay
                        minor={commissions.data.reduce((s, r) => s + r.commissionMinor, 0)}
                        className="font-semibold"
                      />
                    </td>
                    <td colSpan={2} />
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
