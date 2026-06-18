"use client";

import { useState } from "react";
import { ArrowDownCircle, ArrowLeft } from "lucide-react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DatePicker } from "@/components/ui/date-picker";
import { MoneyDisplay } from "@/components/ui/money";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  useReceivedPayments,
  useAgedReceivables,
  useInvoiceSummary,
} from "@/features/reports/api";
import type { AgedItem, InvoiceSummaryGroup } from "@delta/shared";

function today() { return new Date().toISOString().slice(0, 10); }
function yearStart() { return `${new Date().getFullYear()}-01-01`; }

type GroupBy = "salesperson" | "customer" | "tag";

const BAND_LABELS: Record<string, string> = {
  current: "Current",
  band1to30: "1–30 days",
  band31to60: "31–60 days",
  band61to90: "61–90 days",
  band90plus: "90+ days",
};

const BAND_TONE: Record<string, "neutral" | "warning" | "danger" | "success"> = {
  current: "success",
  band1to30: "neutral",
  band31to60: "warning",
  band61to90: "danger",
  band90plus: "danger",
};

export default function ReceivablesPage() {
  const router = useRouter();
  const [from, setFrom] = useState(yearStart());
  const [to, setTo] = useState(today());
  const [groupBy, setGroupBy] = useState<GroupBy>("customer");

  const { data: paymentsData, isLoading: paymentsLoading } = useReceivedPayments(from, to);
  const { data: agedData, isLoading: agedLoading } = useAgedReceivables();
  const { data: summaryData, isLoading: summaryLoading } = useInvoiceSummary(from, to, groupBy);

  // Flatten aged items for the table with band label
  const agedRows: (AgedItem & { band: string })[] = agedData
    ? [
        ...agedData.current.map((i) => ({ ...i, band: "current" })),
        ...agedData.band1to30.map((i) => ({ ...i, band: "band1to30" })),
        ...agedData.band31to60.map((i) => ({ ...i, band: "band31to60" })),
        ...agedData.band61to90.map((i) => ({ ...i, band: "band61to90" })),
        ...agedData.band90plus.map((i) => ({ ...i, band: "band90plus" })),
      ]
    : [];

  const agedColumns: Column<AgedItem & { band: string }>[] = [
    { key: "number", header: "Invoice #", sortable: true, cell: (r) => <span className="font-mono text-sm">{r.number}</span> },
    { key: "partyName", header: "Customer", sortable: true, cell: (r) => <>{r.partyName}</> },
    { key: "dueDate", header: "Due Date", sortable: true, cell: (r) => <>{r.dueDate}</> },
    {
      key: "band",
      header: "Aging",
      cell: (r) => <Badge tone={BAND_TONE[r.band]}>{BAND_LABELS[r.band]}</Badge>,
    },
    {
      key: "totalMinor",
      header: "Invoice Total",
      align: "right",
      sortable: true,
      cell: (r) => <MoneyDisplay minor={r.totalMinor} />,
    },
    {
      key: "balanceMinor",
      header: "Outstanding",
      align: "right",
      sortable: true,
      cell: (r) => <MoneyDisplay minor={r.balanceMinor} className="font-semibold text-danger" />,
    },
    {
      key: "daysOverdue",
      header: "Days",
      align: "right",
      sortable: true,
      cell: (r) => (
        <span className={r.daysOverdue > 0 ? "text-danger font-medium" : "text-foreground-muted"}>
          {r.daysOverdue > 0 ? `+${r.daysOverdue}` : "—"}
        </span>
      ),
    },
  ];

  const summaryColumns: Column<InvoiceSummaryGroup>[] = [
    { key: "label", header: groupBy === "salesperson" ? "Salesperson" : groupBy === "customer" ? "Customer" : "Tag", sortable: true, cell: (r) => <>{r.label}</> },
    { key: "count", header: "Invoices", align: "right", sortable: true, cell: (r) => <>{r.count}</> },
    {
      key: "totalMinor",
      header: "Total Billed",
      align: "right",
      sortable: true,
      cell: (r) => <MoneyDisplay minor={r.totalMinor} />,
    },
    {
      key: "paidMinor",
      header: "Paid",
      align: "right",
      sortable: true,
      cell: (r) => <MoneyDisplay minor={r.paidMinor} className="text-success" />,
    },
    {
      key: "outstandingMinor",
      header: "Outstanding",
      align: "right",
      sortable: true,
      cell: (r) => <MoneyDisplay minor={r.outstandingMinor} className="text-danger" />,
    },
  ];

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        icon={ArrowDownCircle}
        title="Receivables"
        description="Payments received, aged invoices, and invoice summaries."
        action={
          <Button variant="outline" onClick={() => router.push("/reports")}>
            <ArrowLeft className="h-4 w-4" /> All reports
          </Button>
        }
      />

      {/* Date range filter */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-3">
        <span className="text-sm text-foreground-muted">Period:</span>
        <DatePicker value={from} onChange={setFrom} placeholder="From" />
        <span className="text-foreground-subtle">→</span>
        <DatePicker value={to} onChange={setTo} placeholder="To" />
      </div>

      {/* ── Payments received ── */}
      <section className="space-y-3">
        <h2 className="text-base font-semibold">Total Payments Received</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border border-border bg-surface p-5">
            <p className="text-sm text-foreground-muted">Total received</p>
            {paymentsLoading ? (
              <div className="mt-1 h-8 w-32 animate-pulse rounded bg-surface-muted" />
            ) : (
              <MoneyDisplay minor={paymentsData?.totalMinor ?? 0} className="mt-1 text-2xl font-bold" />
            )}
          </div>
          {!paymentsLoading && paymentsData?.byPeriod.slice(0, 3).map((p) => (
            <div key={p.label} className="rounded-xl border border-border bg-surface p-5">
              <p className="text-sm text-foreground-muted">{p.label}</p>
              <MoneyDisplay minor={p.amountMinor} className="mt-1 text-2xl font-bold" />
            </div>
          ))}
        </div>
      </section>

      {/* ── Aged receivables ── */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Aged Receivables</h2>
          {agedData && (
            <div className="flex flex-wrap gap-3 text-sm">
              {(["current", "band1to30", "band31to60", "band61to90", "band90plus"] as const).map((band) => (
                <span key={band} className="flex items-center gap-1.5">
                  <Badge tone={BAND_TONE[band]} className="text-xs">{BAND_LABELS[band]}</Badge>
                  <MoneyDisplay minor={agedData.totals[band]} className="text-foreground-muted" />
                </span>
              ))}
            </div>
          )}
        </div>
        <DataTable
          columns={agedColumns}
          data={agedRows}
          getRowId={(r) => r.id}
          total={agedRows.length}
          page={1}
          pageSize={agedRows.length || 10}
          onPageChange={() => {}}
          onPageSizeChange={() => {}}
          isLoading={agedLoading}
          emptyMessage="No outstanding receivables."
        />
      </section>

      {/* ── Invoice summary ── */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Invoice Summary</h2>
          <Select value={groupBy} onValueChange={(v) => setGroupBy(v as GroupBy)}>
            <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="customer">By Customer</SelectItem>
              <SelectItem value="salesperson">By Salesperson</SelectItem>
              <SelectItem value="tag">By Tag</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <DataTable
          columns={summaryColumns}
          data={summaryData?.items ?? []}
          getRowId={(r) => r.id}
          total={summaryData?.items.length ?? 0}
          page={1}
          pageSize={(summaryData?.items.length || 10)}
          onPageChange={() => {}}
          onPageSizeChange={() => {}}
          isLoading={summaryLoading}
          emptyMessage="No invoices found for this period."
        />
      </section>
    </div>
  );
}
