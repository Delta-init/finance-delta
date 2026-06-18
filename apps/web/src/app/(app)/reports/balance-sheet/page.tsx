"use client";

import { useState } from "react";
import { Scale, ArrowLeft } from "lucide-react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { MoneyDisplay } from "@/components/ui/money";
import { useBalanceSheet } from "@/features/reports/api";

function today() { return new Date().toISOString().slice(0, 10); }

function BSSection({ title, rows, total, totalLabel }: {
  title: string;
  rows: { label: string; amountMinor: number }[];
  total: number;
  totalLabel: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <h3 className="font-semibold text-foreground mb-4">{title}</h3>
      <div className="space-y-0.5">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between py-2 pl-4">
            <span className="text-sm text-foreground-muted">{row.label}</span>
            <MoneyDisplay minor={row.amountMinor} className="text-sm" />
          </div>
        ))}
        <div className="flex items-center justify-between border-t border-border pt-3 mt-2">
          <span className="font-semibold text-sm">{totalLabel}</span>
          <MoneyDisplay minor={total} className="font-semibold text-sm" />
        </div>
      </div>
    </div>
  );
}

export default function BalanceSheetPage() {
  const router = useRouter();
  const [asOf, setAsOf] = useState(today());

  const { data, isLoading } = useBalanceSheet(asOf);

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        icon={Scale}
        title="Balance Sheet"
        description="Snapshot of assets, liabilities, and equity at a point in time."
        action={
          <Button variant="outline" onClick={() => router.push("/reports")}>
            <ArrowLeft className="h-4 w-4" /> All reports
          </Button>
        }
      />

      {/* Date picker */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-3">
        <span className="text-sm text-foreground-muted">As of date:</span>
        <DatePicker value={asOf} onChange={setAsOf} placeholder="Select date" />
      </div>

      {/* Summary row */}
      <div className="grid gap-4 sm:grid-cols-3">
        {[
          { label: "Total Assets", value: data?.assets.total ?? 0, color: "text-success" },
          { label: "Total Liabilities", value: data?.liabilities.total ?? 0, color: "text-danger" },
          { label: "Net Equity", value: data?.equity ?? 0, color: (data?.equity ?? 0) >= 0 ? "text-primary" : "text-danger" },
        ].map((card) => (
          <div key={card.label} className="rounded-xl border border-border bg-surface p-5">
            <p className="text-sm text-foreground-muted">{card.label}</p>
            {isLoading ? (
              <div className="mt-1 h-8 w-32 animate-pulse rounded bg-surface-muted" />
            ) : (
              <MoneyDisplay minor={card.value} className={`mt-1 text-2xl font-bold ${card.color}`} />
            )}
          </div>
        ))}
      </div>

      {/* Detailed sections */}
      {!isLoading && data && (
        <div className="grid gap-6 lg:grid-cols-3">
          <BSSection
            title="Assets"
            rows={[{ label: "Accounts Receivable", amountMinor: data.assets.accountsReceivable }]}
            total={data.assets.total}
            totalLabel="Total Assets"
          />
          <BSSection
            title="Liabilities"
            rows={[{ label: "Accounts Payable", amountMinor: data.liabilities.accountsPayable }]}
            total={data.liabilities.total}
            totalLabel="Total Liabilities"
          />
          <div className="rounded-xl border border-border bg-surface p-5">
            <h3 className="font-semibold text-foreground mb-4">Equity</h3>
            <div className="space-y-0.5">
              <div className="flex items-center justify-between py-2 pl-4">
                <span className="text-sm text-foreground-muted">Net Assets (Assets – Liabilities)</span>
                <MoneyDisplay minor={data.equity} className="text-sm" />
              </div>
              <div className="flex items-center justify-between border-t border-border pt-3 mt-2">
                <span className="font-semibold text-sm">Total Equity</span>
                <MoneyDisplay minor={data.equity} className={`font-semibold text-sm ${data.equity >= 0 ? "text-success" : "text-danger"}`} />
              </div>
            </div>
            <p className="mt-4 text-xs text-foreground-subtle">As of {data.asOf}</p>
          </div>
        </div>
      )}

      {/* Accounting equation */}
      {!isLoading && data && (
        <div className="rounded-lg border border-border bg-surface-muted px-5 py-4">
          <p className="text-sm text-foreground-muted text-center">
            Assets (<MoneyDisplay minor={data.assets.total} className="font-medium" />)
            {" = "}
            Liabilities (<MoneyDisplay minor={data.liabilities.total} className="font-medium" />)
            {" + "}
            Equity (<MoneyDisplay minor={data.equity} className="font-medium" />)
          </p>
        </div>
      )}
    </div>
  );
}
