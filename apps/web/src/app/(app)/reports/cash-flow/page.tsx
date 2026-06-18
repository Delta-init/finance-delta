"use client";

import { useState } from "react";
import { Activity, ArrowLeft, ArrowDownCircle, ArrowUpCircle, Minus } from "lucide-react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { MoneyDisplay } from "@/components/ui/money";
import { useCashFlow } from "@/features/reports/api";

function today() { return new Date().toISOString().slice(0, 10); }
function yearStart() { return `${new Date().getFullYear()}-01-01`; }

function CashSection({ title, icon: Icon, rows, net, netLabel }: {
  title: string;
  icon: typeof Activity;
  rows: { label: string; amountMinor: number; type: "in" | "out" | "net" }[];
  net: number;
  netLabel: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <div className="flex items-center gap-2 mb-4">
        <Icon className="h-5 w-5 text-foreground-muted" />
        <h3 className="font-semibold">{title}</h3>
      </div>
      <div className="space-y-0.5">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between py-2 pl-4">
            <div className="flex items-center gap-2">
              {row.type === "in" && <ArrowDownCircle className="h-3.5 w-3.5 text-success" />}
              {row.type === "out" && <ArrowUpCircle className="h-3.5 w-3.5 text-danger" />}
              {row.type === "net" && <Minus className="h-3.5 w-3.5 text-foreground-subtle" />}
              <span className="text-sm text-foreground-muted">{row.label}</span>
            </div>
            <MoneyDisplay
              minor={row.amountMinor}
              className={`text-sm ${row.type === "in" ? "text-success" : row.type === "out" ? "text-danger" : ""}`}
            />
          </div>
        ))}
        <div className="flex items-center justify-between border-t border-border pt-3 mt-2">
          <span className="font-semibold text-sm">{netLabel}</span>
          <MoneyDisplay minor={net} className={`font-semibold text-sm ${net >= 0 ? "text-success" : "text-danger"}`} />
        </div>
      </div>
    </div>
  );
}

export default function CashFlowPage() {
  const router = useRouter();
  const [from, setFrom] = useState(yearStart());
  const [to, setTo] = useState(today());

  const { data, isLoading } = useCashFlow(from, to);

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        icon={Activity}
        title="Cash Flow Statement"
        description="Operating, investing, and financing cash flow for the selected period."
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

      {/* Net cash change card */}
      <div className={`rounded-xl border p-5 ${(data?.netChange ?? 0) >= 0 ? "border-success/30 bg-success/5" : "border-danger/30 bg-danger/5"}`}>
        <p className="text-sm text-foreground-muted">Net Cash Change</p>
        {isLoading ? (
          <div className="mt-1 h-8 w-32 animate-pulse rounded bg-surface-muted" />
        ) : (
          <MoneyDisplay
            minor={data?.netChange ?? 0}
            className={`mt-1 text-3xl font-bold ${(data?.netChange ?? 0) >= 0 ? "text-success" : "text-danger"}`}
          />
        )}
        <p className="mt-1 text-xs text-foreground-muted">{from} → {to}</p>
      </div>

      {/* Sections */}
      {!isLoading && data && (
        <div className="grid gap-6 lg:grid-cols-3">
          <CashSection
            title="Operating Activities"
            icon={Activity}
            rows={[
              { label: "Cash inflows (payments received)", amountMinor: data.operating.inflows, type: "in" },
              { label: "Cash outflows (bills + expenses)", amountMinor: data.operating.outflows, type: "out" },
            ]}
            net={data.operating.net}
            netLabel="Net Operating Cash Flow"
          />
          <CashSection
            title="Investing Activities"
            icon={Activity}
            rows={[
              { label: "Capital expenditures", amountMinor: 0, type: "out" },
            ]}
            net={data.investing.net}
            netLabel="Net Investing Cash Flow"
          />
          <CashSection
            title="Financing Activities"
            icon={Activity}
            rows={[
              { label: "Loan repayments / proceeds", amountMinor: 0, type: "net" },
            ]}
            net={data.financing.net}
            netLabel="Net Financing Cash Flow"
          />
        </div>
      )}

      {/* Summary equation */}
      {!isLoading && data && (
        <div className="rounded-lg border border-border bg-surface-muted px-5 py-4 text-sm text-center text-foreground-muted">
          Operating (<MoneyDisplay minor={data.operating.net} className="font-medium" />)
          {" + "}
          Investing (<MoneyDisplay minor={data.investing.net} className="font-medium" />)
          {" + "}
          Financing (<MoneyDisplay minor={data.financing.net} className="font-medium" />)
          {" = "}
          Net Change (<MoneyDisplay minor={data.netChange} className="font-medium" />)
        </div>
      )}
    </div>
  );
}
