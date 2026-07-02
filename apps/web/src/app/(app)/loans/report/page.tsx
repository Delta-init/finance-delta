"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Landmark } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { MoneyDisplay } from "@/components/ui/money";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataTable, type Column } from "@/components/ui/data-table";
import { useLoanReport } from "@/features/loans/api";
import type { Loan } from "@delta/shared";

const STATUS_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  active: "warning",
  closed: "success",
  defaulted: "danger",
};

export default function LoanReportPage() {
  const searchParams = useSearchParams();
  const [typeFilter, setTypeFilter] = useState<string>(searchParams.get("type") ?? "");
  const [statusFilter, setStatusFilter] = useState<string>(searchParams.get("status") ?? "");

  const { data: report, isLoading } = useLoanReport();

  const loans = (report?.loans ?? []).filter((l) => {
    if (typeFilter && l.type !== typeFilter) return false;
    if (statusFilter && l.status !== statusFilter) return false;
    return true;
  });

  const columns: Column<Loan>[] = [
    {
      key: "loanNumber",
      header: "Loan #",
      sortable: true,
      cell: (r) => (
        <Link href={`/loans/${r.id}`} className="font-mono text-sm font-medium text-primary hover:underline">
          {r.loanNumber}
        </Link>
      ),
    },
    {
      key: "type",
      header: "Type",
      cell: (r) => (
        <Badge tone={r.type === "taken" ? "danger" : "success"} className="capitalize">{r.type}</Badge>
      ),
    },
    {
      key: "counterpartyName",
      header: "Counterparty",
      sortable: true,
      cell: (r) => <span className="font-medium">{r.counterpartyName}</span>,
    },
    {
      key: "principalMinor",
      header: "Principal",
      align: "right",
      sortable: true,
      cell: (r) => <MoneyDisplay minor={r.principalMinor} />,
    },
    {
      key: "outstandingPrincipalMinor",
      header: "Outstanding",
      align: "right",
      sortable: true,
      cell: (r) => (
        <MoneyDisplay
          minor={r.outstandingPrincipalMinor}
          className={r.outstandingPrincipalMinor > 0 ? "text-warning font-semibold" : "text-success"}
        />
      ),
    },
    {
      key: "accruedInterestMinor",
      header: "Accrued Interest",
      align: "right",
      sortable: true,
      cell: (r) => (
        r.accruedInterestMinor > 0 ? (
          <MoneyDisplay minor={r.accruedInterestMinor} className="text-danger" />
        ) : (
          <span className="text-foreground-subtle">—</span>
        )
      ),
    },
    {
      key: "interestRate",
      header: "Rate",
      align: "right",
      cell: (r) => <span className="text-foreground-muted">{r.interestRate}%</span>,
    },
    {
      key: "status",
      header: "Status",
      cell: (r) => (
        <Badge tone={STATUS_TONE[r.status]} className="capitalize">{r.status}</Badge>
      ),
    },
    {
      key: "startDate",
      header: "Start",
      sortable: true,
      cell: (r) => <span className="text-sm text-foreground-muted">{r.startDate}</span>,
    },
    {
      key: "dueDate",
      header: "Due",
      cell: (r) => (
        <span className={`text-sm ${r.dueDate && new Date(r.dueDate) < new Date() && r.status === "active" ? "text-danger font-medium" : "text-foreground-muted"}`}>
          {r.dueDate ?? "—"}
        </span>
      ),
    },
  ];

  const report_ = report;
  const totalOutstanding =
    (report_?.taken.outstandingMinor ?? 0) + (report_?.given.outstandingMinor ?? 0);

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        icon={Landmark}
        title="Loan Summary Report"
        description="All loans — active, closed, and defaulted — with outstanding balances and accrued interest."
      />

      {/* Totals */}
      {report_ && (
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-xl border border-border bg-surface p-5">
            <p className="text-sm text-foreground-muted">Total Borrowed (outstanding)</p>
            <MoneyDisplay minor={report_.taken.outstandingMinor} className="mt-1 text-xl font-bold text-danger" />
            <p className="text-xs text-foreground-subtle mt-1">
              Principal: <MoneyDisplay minor={report_.taken.principalMinor} className="inline" />
            </p>
          </div>
          <div className="rounded-xl border border-border bg-surface p-5">
            <p className="text-sm text-foreground-muted">Total Lent (outstanding)</p>
            <MoneyDisplay minor={report_.given.outstandingMinor} className="mt-1 text-xl font-bold text-success" />
            <p className="text-xs text-foreground-subtle mt-1">
              Principal: <MoneyDisplay minor={report_.given.principalMinor} className="inline" />
            </p>
          </div>
          <div className="rounded-xl border border-border bg-surface p-5">
            <p className="text-sm text-foreground-muted">Net Loan Position</p>
            <MoneyDisplay minor={totalOutstanding} className="mt-1 text-xl font-bold" />
            <p className="text-xs text-foreground-subtle mt-1">
              {report_.byStatus.find((s) => s.status === "active")?.count ?? 0} active loans
            </p>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-3">
        <span className="text-sm text-foreground-muted">Filter:</span>
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-[140px]"><SelectValue placeholder="All types" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="">All types</SelectItem>
            <SelectItem value="taken">Taken</SelectItem>
            <SelectItem value="given">Given</SelectItem>
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[140px]"><SelectValue placeholder="All statuses" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="">All statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="closed">Closed</SelectItem>
            <SelectItem value="defaulted">Defaulted</SelectItem>
          </SelectContent>
        </Select>
        {(typeFilter || statusFilter) && (
          <button
            onClick={() => { setTypeFilter(""); setStatusFilter(""); }}
            className="text-xs text-primary underline"
          >
            Clear filters
          </button>
        )}
      </div>

      <DataTable
        columns={columns}
        data={loans}
        getRowId={(r) => r.id}
        total={loans.length}
        page={1}
        pageSize={loans.length || 20}
        onPageChange={() => {}}
        onPageSizeChange={() => {}}
        isLoading={isLoading}
        emptyMessage="No loans match the selected filters."
      />

      {report_ && (
        <p className="text-xs text-foreground-subtle">
          As of {report_.asOf} · Interest accrued dynamically (not stored)
        </p>
      )}
    </div>
  );
}
