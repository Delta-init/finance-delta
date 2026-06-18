"use client";

import { useState } from "react";
import { TrendingUp, ArrowLeft, TrendingDown } from "lucide-react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { MoneyDisplay } from "@/components/ui/money";
import { useProfitLoss } from "@/features/reports/api";

function today() { return new Date().toISOString().slice(0, 10); }
function yearStart() { return `${new Date().getFullYear()}-01-01`; }

function PLRow({ label, amountMinor, indent = false, bold = false }: {
  label: string;
  amountMinor: number;
  indent?: boolean;
  bold?: boolean;
}) {
  return (
    <div className={`flex items-center justify-between py-2 ${indent ? "pl-4" : ""} ${bold ? "border-t border-border mt-1 pt-3" : ""}`}>
      <span className={`text-sm ${bold ? "font-semibold" : "text-foreground-muted"}`}>{label}</span>
      <MoneyDisplay minor={amountMinor} className={`text-sm ${bold ? "font-semibold" : ""}`} />
    </div>
  );
}

export default function ProfitLossPage() {
  const router = useRouter();
  const [from, setFrom] = useState(yearStart());
  const [to, setTo] = useState(today());

  const { data, isLoading } = useProfitLoss(from, to);

  const netProfit = data?.netProfitMinor ?? 0;
  const priorNet = data?.prior?.netProfitMinor ?? 0;
  const change = priorNet !== 0 ? Math.round(((netProfit - priorNet) / Math.abs(priorNet)) * 100) : null;

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        icon={TrendingUp}
        title="Profit & Loss"
        description="Income, expenses, and net profit for the selected period."
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

      {/* Summary cards */}
      <div className="grid gap-4 sm:grid-cols-3">
        {[
          { label: "Total Income", value: data?.income.total ?? 0, color: "text-success" },
          { label: "Total Expenses", value: data?.expenses.total ?? 0, color: "text-danger" },
          { label: "Net Profit", value: netProfit, color: netProfit >= 0 ? "text-success" : "text-danger" },
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

      {/* Comparative note */}
      {data?.prior && change !== null && (
        <div className={`flex items-center gap-2 rounded-lg border px-4 py-3 text-sm ${change >= 0 ? "border-success/30 bg-success/5 text-success" : "border-danger/30 bg-danger/5 text-danger"}`}>
          {change >= 0 ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
          Net profit is <strong>{change >= 0 ? "+" : ""}{change}%</strong> vs prior period
          ({data.prior.from} → {data.prior.to}):&nbsp;
          <MoneyDisplay minor={priorNet} className="font-medium" />
        </div>
      )}

      {/* P&L breakdown */}
      {!isLoading && data && (
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Income */}
          <div className="rounded-xl border border-border bg-surface p-5">
            <h3 className="font-semibold mb-3">Income</h3>
            {data.income.breakdown.map((item) => (
              <PLRow key={item.label} label={item.label} amountMinor={item.amountMinor} indent />
            ))}
            <PLRow label="Total Income" amountMinor={data.income.total} bold />
          </div>

          {/* Expenses */}
          <div className="rounded-xl border border-border bg-surface p-5">
            <h3 className="font-semibold mb-3">Expenses</h3>
            {data.expenses.breakdown.map((item) => (
              <PLRow key={item.label} label={item.label} amountMinor={item.amountMinor} indent />
            ))}
            <PLRow label="Total Expenses" amountMinor={data.expenses.total} bold />
          </div>
        </div>
      )}

      {/* Net profit */}
      {!isLoading && data && (
        <div className={`rounded-xl border p-5 ${netProfit >= 0 ? "border-success/30 bg-success/5" : "border-danger/30 bg-danger/5"}`}>
          <div className="flex items-center justify-between">
            <span className="font-semibold text-foreground">Net Profit / (Loss)</span>
            <MoneyDisplay minor={netProfit} className={`text-xl font-bold ${netProfit >= 0 ? "text-success" : "text-danger"}`} />
          </div>
          <p className="mt-1 text-xs text-foreground-muted">{from} → {to}</p>
        </div>
      )}
    </div>
  );
}
