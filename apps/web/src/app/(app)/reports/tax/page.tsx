"use client";

import { useState } from "react";
import { Receipt, ArrowLeft } from "lucide-react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { MoneyDisplay } from "@/components/ui/money";
import { DataTable, type Column } from "@/components/ui/data-table";
import { useVATReport } from "@/features/reports/api";

function today() { return new Date().toISOString().slice(0, 10); }
function yearStart() { return `${new Date().getFullYear()}-01-01`; }

export default function TaxPage() {
  const router = useRouter();
  const [from, setFrom] = useState(yearStart());
  const [to, setTo] = useState(today());

  const { data, isLoading } = useVATReport(from, to);

  type RateRow = { code: string; rate: number; outputMinor: number; inputMinor: number };

  const rateColumns: Column<RateRow>[] = [
    { key: "code", header: "Tax Code", sortable: true, cell: (r) => <>{r.code}</> },
    {
      key: "outputMinor",
      header: "Output Tax (Invoices)",
      align: "right",
      sortable: true,
      cell: (r) => <MoneyDisplay minor={r.outputMinor} />,
    },
    {
      key: "inputMinor",
      header: "Input Tax (Bills)",
      align: "right",
      sortable: true,
      cell: (r) => <MoneyDisplay minor={r.inputMinor} />,
    },
    {
      key: "rate",
      header: "Net",
      align: "right",
      cell: (r) => <MoneyDisplay minor={r.outputMinor - r.inputMinor} />,
    },
  ];

  const net = data?.netPayableMinor ?? 0;

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        icon={Receipt}
        title="Tax Reports"
        description="VAT return: output tax from invoices, input tax from bills, and net payable."
        action={
          <Button variant="outline" onClick={() => router.push("/reports")}>
            <ArrowLeft className="h-4 w-4" /> All reports
          </Button>
        }
      />

      {/* Date filter */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-3">
        <span className="text-sm text-foreground-muted">VAT period:</span>
        <DatePicker value={from} onChange={setFrom} placeholder="From" />
        <span className="text-foreground-subtle">→</span>
        <DatePicker value={to} onChange={setTo} placeholder="To" />
      </div>

      {/* Summary cards */}
      <div className="grid gap-4 sm:grid-cols-3">
        {[
          {
            label: "Output Tax",
            sublabel: "Tax collected on sales",
            value: data?.outputTaxMinor ?? 0,
            color: "text-danger",
          },
          {
            label: "Input Tax",
            sublabel: "Tax paid on purchases",
            value: data?.inputTaxMinor ?? 0,
            color: "text-success",
          },
          {
            label: "Net VAT Payable",
            sublabel: "Output − Input",
            value: net,
            color: net >= 0 ? "text-danger" : "text-success",
          },
        ].map((card) => (
          <div key={card.label} className="rounded-xl border border-border bg-surface p-5">
            <p className="text-sm font-medium text-foreground">{card.label}</p>
            <p className="text-xs text-foreground-muted mb-2">{card.sublabel}</p>
            {isLoading ? (
              <div className="h-8 w-32 animate-pulse rounded bg-surface-muted" />
            ) : (
              <MoneyDisplay minor={card.value} className={`text-2xl font-bold ${card.color}`} />
            )}
          </div>
        ))}
      </div>

      {/* VAT return summary box */}
      {!isLoading && data && (
        <div className="rounded-xl border border-border bg-surface p-6 space-y-3">
          <h3 className="font-semibold">UAE VAT Return Summary</h3>
          <div className="space-y-1 divide-y divide-border">
            <div className="flex justify-between py-2.5 text-sm">
              <span className="text-foreground-muted">Box 1 — Output tax on sales</span>
              <MoneyDisplay minor={data.outputTaxMinor} />
            </div>
            <div className="flex justify-between py-2.5 text-sm">
              <span className="text-foreground-muted">Box 2 — Input tax on expenses</span>
              <MoneyDisplay minor={data.inputTaxMinor} />
            </div>
            <div className="flex justify-between py-2.5 text-sm font-semibold">
              <span>Net VAT payable / (refundable)</span>
              <MoneyDisplay minor={net} className={net >= 0 ? "text-danger" : "text-success"} />
            </div>
          </div>
          <p className="text-xs text-foreground-subtle">Period: {data.from} to {data.to}</p>
        </div>
      )}

      {/* By rate breakdown */}
      {!isLoading && (data?.byRate.length ?? 0) > 0 && (
        <section className="space-y-3">
          <h3 className="text-base font-semibold">Breakdown by Tax Code</h3>
          <DataTable
            columns={rateColumns}
            data={data?.byRate ?? []}
            getRowId={(r) => r.code}
            total={data?.byRate.length ?? 0}
            page={1}
            pageSize={data?.byRate.length || 10}
            onPageChange={() => {}}
            onPageSizeChange={() => {}}
            isLoading={isLoading}
            emptyMessage="No tax data for this period."
          />
        </section>
      )}
    </div>
  );
}
