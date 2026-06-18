"use client";

import { useState } from "react";
import Link from "next/link";
import { TrendingUp, Plus, FileText, Settings2 } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { MoneyDisplay } from "@/components/ui/money";
import { DatePicker } from "@/components/ui/date-picker";
import { useCommissionReport, useCommissionStructures, useCommissionRecords } from "@/features/commissions/api";

function today() { return new Date().toISOString().slice(0, 10); }
function yearStart() { return `${new Date().getFullYear()}-01-01`; }

export default function CommissionsPage() {
  const [from, setFrom] = useState(yearStart());
  const [to, setTo] = useState(today());

  const { data: report, isLoading: reportLoading } = useCommissionReport(from, to);
  const { data: structures } = useCommissionStructures();
  const { data: records } = useCommissionRecords({ status: "earned", page: 1, pageSize: 1 });

  const summaryCards = [
    { label: "Total Earned", value: report?.totals.earnedMinor ?? 0, className: "text-foreground" },
    { label: "Total Paid", value: report?.totals.paidMinor ?? 0, className: "text-success" },
    { label: "Pending Payment", value: report?.totals.pendingMinor ?? 0, className: "text-warning" },
  ];

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        icon={TrendingUp}
        title="Commissions"
        description="Track sales commissions, manage structures, and process payouts."
        action={
          <Link href="/commissions/structures/new">
            <Button><Plus className="h-4 w-4" /> New Structure</Button>
          </Link>
        }
      />

      {/* Period filter */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-3">
        <span className="text-sm text-foreground-muted">Period:</span>
        <DatePicker value={from} onChange={setFrom} placeholder="From" />
        <span className="text-foreground-subtle">→</span>
        <DatePicker value={to} onChange={setTo} placeholder="To" />
      </div>

      {/* Summary cards */}
      <div className="grid gap-4 sm:grid-cols-3">
        {summaryCards.map(({ label, value, className }) => (
          <div key={label} className="rounded-xl border border-border bg-surface p-5">
            <p className="text-sm text-foreground-muted">{label}</p>
            {reportLoading ? (
              <div className="mt-1 h-8 w-32 animate-pulse rounded bg-surface-muted" />
            ) : (
              <MoneyDisplay minor={value} className={`mt-1 text-2xl font-bold ${className}`} />
            )}
          </div>
        ))}
      </div>

      {/* Quick nav */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Link href="/commissions/structures" className="group rounded-xl border border-border bg-surface p-5 transition-colors hover:border-primary/40 hover:bg-surface-muted">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Settings2 className="h-5 w-5" />
            </div>
            <div>
              <p className="font-semibold text-foreground">Structures</p>
              <p className="text-sm text-foreground-muted">
                {structures ? `${structures.length} active` : "Manage rates"}
              </p>
            </div>
          </div>
        </Link>

        <Link href="/commissions/records" className="group rounded-xl border border-border bg-surface p-5 transition-colors hover:border-primary/40 hover:bg-surface-muted">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-warning/10 text-warning">
              <FileText className="h-5 w-5" />
            </div>
            <div>
              <p className="font-semibold text-foreground">Records</p>
              <p className="text-sm text-foreground-muted">
                {records?.meta.total ? `${records.meta.total} pending` : "View all records"}
              </p>
            </div>
          </div>
        </Link>

        <Link href="/commissions/report" className="group rounded-xl border border-border bg-surface p-5 transition-colors hover:border-primary/40 hover:bg-surface-muted">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-success/10 text-success">
              <TrendingUp className="h-5 w-5" />
            </div>
            <div>
              <p className="font-semibold text-foreground">Report</p>
              <p className="text-sm text-foreground-muted">By salesperson</p>
            </div>
          </div>
        </Link>
      </div>

      {/* Period breakdown by salesperson */}
      {report && report.rows.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-base font-semibold">Breakdown by Salesperson</h2>
          <div className="overflow-hidden rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-surface-muted">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-foreground-muted">Salesperson</th>
                  <th className="px-4 py-3 text-right font-medium text-foreground-muted">Invoices</th>
                  <th className="px-4 py-3 text-right font-medium text-foreground-muted">Earned</th>
                  <th className="px-4 py-3 text-right font-medium text-foreground-muted">Paid</th>
                  <th className="px-4 py-3 text-right font-medium text-foreground-muted">Pending</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {report.rows.map((row) => (
                  <tr key={row.salespersonId} className="bg-surface hover:bg-surface-muted/50">
                    <td className="px-4 py-3 font-medium text-foreground">{row.salespersonName}</td>
                    <td className="px-4 py-3 text-right text-foreground-muted">{row.invoiceCount}</td>
                    <td className="px-4 py-3 text-right">
                      <MoneyDisplay minor={row.earnedMinor + row.paidMinor} />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <MoneyDisplay minor={row.paidMinor} className="text-success" />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <MoneyDisplay minor={row.pendingMinor} className="text-warning font-semibold" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
