"use client";

import { useState } from "react";
import { TrendingUp } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { MoneyDisplay } from "@/components/ui/money";
import { DatePicker } from "@/components/ui/date-picker";
import { DataTable, type Column } from "@/components/ui/data-table";
import { useCommissionReport } from "@/features/commissions/api";
import type { CommissionReportRow } from "@delta/shared";

function today() { return new Date().toISOString().slice(0, 10); }
function yearStart() { return `${new Date().getFullYear()}-01-01`; }

export default function CommissionReportPage() {
  const [from, setFrom] = useState(yearStart());
  const [to, setTo] = useState(today());

  const { data: report, isLoading } = useCommissionReport(from, to);

  const columns: Column<CommissionReportRow>[] = [
    {
      key: "salespersonName",
      header: "Salesperson",
      sortable: true,
      cell: (r) => <span className="font-medium text-foreground">{r.salespersonName}</span>,
    },
    {
      key: "invoiceCount",
      header: "Invoices",
      align: "right",
      sortable: true,
      cell: (r) => <span className="text-foreground-muted">{r.invoiceCount}</span>,
    },
    {
      key: "earnedMinor",
      header: "Total Earned",
      align: "right",
      sortable: true,
      cell: (r) => <MoneyDisplay minor={r.earnedMinor + r.paidMinor} />,
    },
    {
      key: "paidMinor",
      header: "Paid Out",
      align: "right",
      sortable: true,
      cell: (r) => <MoneyDisplay minor={r.paidMinor} className="text-success" />,
    },
    {
      key: "pendingMinor",
      header: "Pending",
      align: "right",
      sortable: true,
      cell: (r) => <MoneyDisplay minor={r.earnedMinor} className="text-warning font-semibold" />,
    },
  ];

  const totals = report?.totals;

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        icon={TrendingUp}
        title="Commission Report"
        description="Period summary of commissions earned and paid per salesperson."
      />

      {/* Period filter */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-3">
        <span className="text-sm text-foreground-muted">Period:</span>
        <DatePicker value={from} onChange={setFrom} placeholder="From" />
        <span className="text-foreground-subtle">→</span>
        <DatePicker value={to} onChange={setTo} placeholder="To" />
      </div>

      {/* Totals */}
      {totals && (
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-xl border border-border bg-surface p-5">
            <p className="text-sm text-foreground-muted">Total Earned</p>
            <MoneyDisplay minor={totals.earnedMinor} className="mt-1 text-2xl font-bold" />
          </div>
          <div className="rounded-xl border border-border bg-surface p-5">
            <p className="text-sm text-foreground-muted">Paid Out</p>
            <MoneyDisplay minor={totals.paidMinor} className="mt-1 text-2xl font-bold text-success" />
          </div>
          <div className="rounded-xl border border-border bg-surface p-5">
            <p className="text-sm text-foreground-muted">Pending</p>
            <MoneyDisplay minor={totals.pendingMinor} className="mt-1 text-2xl font-bold text-warning" />
          </div>
        </div>
      )}

      {/* Table */}
      <DataTable
        columns={columns}
        data={report?.rows ?? []}
        getRowId={(r) => r.salespersonId}
        total={report?.rows.length ?? 0}
        page={1}
        pageSize={report?.rows.length || 20}
        onPageChange={() => {}}
        onPageSizeChange={() => {}}
        isLoading={isLoading}
        emptyMessage="No commission records found for this period."
      />

      {/* Footer */}
      {report && report.rows.length > 0 && (
        <div className="rounded-lg border border-border bg-surface-muted px-4 py-3 text-sm text-foreground-muted">
          Period: {report.from} → {report.to} · Rates in {report.currency}
        </div>
      )}
    </div>
  );
}
