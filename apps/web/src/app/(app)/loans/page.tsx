"use client";

import Link from "next/link";
import { Landmark, Plus, TrendingDown, TrendingUp, AlertCircle } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MoneyDisplay } from "@/components/ui/money";
import { useLoans, useLoanReport } from "@/features/loans/api";

const STATUS_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  active: "warning",
  closed: "success",
  defaulted: "danger",
};

const FREQ_LABELS: Record<string, string> = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  annually: "Annual",
  bullet: "Bullet",
  none: "None",
};

export default function LoansPage() {
  const { data: report, isLoading: reportLoading } = useLoanReport();
  const { data: activeData, isLoading: listLoading } = useLoans({ status: "active", pageSize: 50 });

  const summaryCards = [
    {
      label: "Loans Taken",
      sub: `${report?.taken.count ?? 0} active`,
      value: report?.taken.outstandingMinor ?? 0,
      icon: TrendingDown,
      color: "text-danger",
      bg: "bg-danger/10",
    },
    {
      label: "Loans Given",
      sub: `${report?.given.count ?? 0} active`,
      value: report?.given.outstandingMinor ?? 0,
      icon: TrendingUp,
      color: "text-success",
      bg: "bg-success/10",
    },
    {
      label: "Interest Accrued (Taken)",
      sub: "Outstanding interest owed",
      value: report?.taken.interestAccruedMinor ?? 0,
      icon: AlertCircle,
      color: "text-warning",
      bg: "bg-warning/10",
    },
    {
      label: "Interest Accrued (Given)",
      sub: "Outstanding interest receivable",
      value: report?.given.interestAccruedMinor ?? 0,
      icon: AlertCircle,
      color: "text-primary",
      bg: "bg-primary/10",
    },
  ];

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        icon={Landmark}
        title="Loans & Credit"
        description="Track loans taken and given, repayment schedules, and interest accrual."
        action={
          <Link href="/loans/new">
            <Button><Plus className="h-4 w-4" /> New Loan</Button>
          </Link>
        }
      />

      {/* Summary cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {summaryCards.map(({ label, sub, value, icon: Icon, color, bg }) => (
          <div key={label} className="rounded-xl border border-border bg-surface p-5">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-sm text-foreground-muted">{label}</p>
                <p className="mt-0.5 text-xs text-foreground-subtle">{sub}</p>
              </div>
              <div className={`rounded-lg p-2 ${bg}`}>
                <Icon className={`h-4 w-4 ${color}`} />
              </div>
            </div>
            {reportLoading ? (
              <div className="mt-3 h-7 w-28 animate-pulse rounded bg-surface-muted" />
            ) : (
              <MoneyDisplay minor={value} className={`mt-3 text-xl font-bold ${color}`} />
            )}
          </div>
        ))}
      </div>

      {/* By-status breakdown */}
      {report && (
        <div className="grid gap-4 sm:grid-cols-3">
          {report.byStatus.map(({ status, count, outstandingMinor }) => (
            <Link
              key={status}
              href={`/loans/report?status=${status}`}
              className="rounded-xl border border-border bg-surface p-4 transition-colors hover:border-primary/40 hover:bg-surface-muted"
            >
              <div className="flex items-center justify-between">
                <Badge tone={STATUS_TONE[status]} className="capitalize">{status}</Badge>
                <span className="text-sm text-foreground-muted">{count} loans</span>
              </div>
              <MoneyDisplay minor={outstandingMinor} className="mt-2 text-lg font-semibold" />
              <p className="text-xs text-foreground-subtle">outstanding principal</p>
            </Link>
          ))}
        </div>
      )}

      {/* Active loans list */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Active Loans</h2>
          <Link href="/loans/report">
            <Button variant="outline" size="sm">View All</Button>
          </Link>
        </div>

        {listLoading ? (
          <div className="space-y-2">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-16 animate-pulse rounded-xl bg-surface-muted" />
            ))}
          </div>
        ) : !activeData?.data.length ? (
          <div className="rounded-xl border border-border bg-surface p-8 text-center">
            <Landmark className="mx-auto h-10 w-10 text-foreground-subtle" />
            <p className="mt-3 text-sm font-medium text-foreground">No active loans</p>
            <p className="text-xs text-foreground-muted">
              Record a loan taken or given to start tracking.
            </p>
            <Link href="/loans/new" className="mt-4 inline-block">
              <Button size="sm"><Plus className="h-4 w-4" /> New Loan</Button>
            </Link>
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-surface-muted">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-foreground-muted">Loan #</th>
                  <th className="px-4 py-3 text-left font-medium text-foreground-muted">Type</th>
                  <th className="px-4 py-3 text-left font-medium text-foreground-muted">Counterparty</th>
                  <th className="px-4 py-3 text-right font-medium text-foreground-muted">Principal</th>
                  <th className="px-4 py-3 text-right font-medium text-foreground-muted">Outstanding</th>
                  <th className="px-4 py-3 text-right font-medium text-foreground-muted">Rate</th>
                  <th className="px-4 py-3 text-left font-medium text-foreground-muted">Due</th>
                  <th className="px-4 py-3 text-left font-medium text-foreground-muted">Freq</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {activeData.data.map((loan) => (
                  <tr key={loan.id} className="bg-surface hover:bg-surface-muted/50">
                    <td className="px-4 py-3">
                      <Link
                        href={`/loans/${loan.id}`}
                        className="font-mono text-sm font-medium text-primary hover:underline"
                      >
                        {loan.loanNumber}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={loan.type === "taken" ? "danger" : "success"} className="capitalize">
                        {loan.type}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 font-medium">{loan.counterpartyName}</td>
                    <td className="px-4 py-3 text-right">
                      <MoneyDisplay minor={loan.principalMinor} />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <MoneyDisplay
                        minor={loan.outstandingPrincipalMinor}
                        className="font-semibold text-warning"
                      />
                    </td>
                    <td className="px-4 py-3 text-right text-foreground-muted">
                      {loan.interestRate}%
                    </td>
                    <td className="px-4 py-3 text-foreground-muted">
                      {loan.dueDate ?? <span className="text-foreground-subtle">—</span>}
                    </td>
                    <td className="px-4 py-3 text-foreground-muted">
                      {FREQ_LABELS[loan.repaymentFrequency]}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
