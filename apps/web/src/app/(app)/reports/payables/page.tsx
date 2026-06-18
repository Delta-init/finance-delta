"use client";

import { useState } from "react";
import { ArrowUpCircle, ArrowLeft } from "lucide-react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DatePicker } from "@/components/ui/date-picker";
import { MoneyDisplay } from "@/components/ui/money";
import { DataTable, type Column } from "@/components/ui/data-table";
import { useMadePayments, useAgedPayables } from "@/features/reports/api";
import type { AgedItem } from "@delta/shared";

function today() { return new Date().toISOString().slice(0, 10); }
function yearStart() { return `${new Date().getFullYear()}-01-01`; }

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

export default function PayablesPage() {
  const router = useRouter();
  const [from, setFrom] = useState(yearStart());
  const [to, setTo] = useState(today());

  const { data: paymentsData, isLoading: paymentsLoading } = useMadePayments(from, to);
  const { data: agedData, isLoading: agedLoading } = useAgedPayables();

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
    { key: "number", header: "Bill #", sortable: true, cell: (r) => <span className="font-mono text-sm">{r.number}</span> },
    { key: "partyName", header: "Vendor", sortable: true, cell: (r) => <>{r.partyName}</> },
    { key: "dueDate", header: "Due Date", sortable: true, cell: (r) => <>{r.dueDate}</> },
    {
      key: "band",
      header: "Aging",
      cell: (r) => <Badge tone={BAND_TONE[r.band]}>{BAND_LABELS[r.band]}</Badge>,
    },
    {
      key: "totalMinor",
      header: "Bill Total",
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

  type VendorRow = { vendorId: string; vendorName: string; amountMinor: number };
  const vendorColumns: Column<VendorRow>[] = [
    { key: "vendorName", header: "Vendor", sortable: true, cell: (r) => <>{r.vendorName}</> },
    {
      key: "amountMinor",
      header: "Amount Paid",
      align: "right",
      sortable: true,
      cell: (r) => <MoneyDisplay minor={r.amountMinor} />,
    },
  ];

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        icon={ArrowUpCircle}
        title="Payables"
        description="Payments made to vendors and aged outstanding bills."
        action={
          <Button variant="outline" onClick={() => router.push("/reports")}>
            <ArrowLeft className="h-4 w-4" /> All reports
          </Button>
        }
      />

      {/* Date filter */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-3">
        <span className="text-sm text-foreground-muted">Period:</span>
        <DatePicker value={from} onChange={setFrom} placeholder="From" />
        <span className="text-foreground-subtle">→</span>
        <DatePicker value={to} onChange={setTo} placeholder="To" />
      </div>

      {/* Payments made summary */}
      <section className="space-y-3">
        <h2 className="text-base font-semibold">Total Payments Made</h2>
        <div className="rounded-xl border border-border bg-surface p-5 max-w-xs">
          <p className="text-sm text-foreground-muted">Total paid</p>
          {paymentsLoading ? (
            <div className="mt-1 h-8 w-32 animate-pulse rounded bg-surface-muted" />
          ) : (
            <MoneyDisplay minor={paymentsData?.totalMinor ?? 0} className="mt-1 text-2xl font-bold" />
          )}
        </div>

        {/* By vendor */}
        {!paymentsLoading && (paymentsData?.byVendor.length ?? 0) > 0 && (
          <DataTable
            columns={vendorColumns}
            data={paymentsData?.byVendor ?? []}
            getRowId={(r) => r.vendorId}
            total={paymentsData?.byVendor.length ?? 0}
            page={1}
            pageSize={paymentsData?.byVendor.length || 10}
            onPageChange={() => {}}
            onPageSizeChange={() => {}}
            isLoading={paymentsLoading}
            emptyMessage="No payments found for this period."
          />
        )}
      </section>

      {/* Aged payables */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Aged Payables</h2>
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
          emptyMessage="No outstanding payables."
        />
      </section>
    </div>
  );
}
