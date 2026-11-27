"use client";

import { useState } from "react";
import { TrendingUp, ArrowLeft, TrendingDown } from "lucide-react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { MoneyDisplay } from "@/components/ui/money";
import { useProfitLoss } from "@/features/reports/api";
import { PLLineDialog, type PLLinePick } from "@/features/reports/PLLineDialog";
import { formatMoney } from "@delta/shared";

function today() { return new Date().toISOString().slice(0, 10); }
function yearStart() { return `${new Date().getFullYear()}-01-01`; }

function PLRow({ label, amountMinor, indent = false, bold = false, onOpen }: {
  label: string;
  amountMinor: number;
  indent?: boolean;
  bold?: boolean;
  /** Opens the records behind the line (2026-11-27). */
  onOpen?: () => void;
}) {
  const cls = `flex w-full items-center justify-between py-2 text-left ${indent ? "pl-4" : ""} ${bold ? "border-t border-border mt-1 pt-3" : ""}`;
  const body = (
    <>
      <span className={`text-sm ${bold ? "font-semibold" : "text-foreground-muted"} ${onOpen ? "group-hover:text-primary group-hover:underline" : ""}`}>{label}</span>
      <MoneyDisplay minor={amountMinor} className={`text-sm ${bold ? "font-semibold" : ""}`} />
    </>
  );
  return onOpen ? (
    <button type="button" onClick={onOpen} title="See the records behind this line" className={`group rounded-md hover:bg-surface-muted/60 ${cls}`}>{body}</button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

type Basis = "invoiced" | "collected";

/*
 * Income counted by invoices issued or by money received (the user, 2026-11-27: "show total collected instead of total
 * invoiced"). Collected is a cash view: payments received as received, and expenses paid in the period.
 */
const BASES: { key: Basis; label: string }[] = [{ key: "invoiced", label: "Invoiced" }, { key: "collected", label: "Collected" }];

export default function ProfitLossPage() {
  const router = useRouter();
  const [from, setFrom] = useState(yearStart());
  const [to, setTo] = useState(today());
  const [basis, setBasis] = useState<Basis>("invoiced");

  const { data, isLoading } = useProfitLoss(from, to, basis);
  const collected = basis === "collected";
  const [linePick, setLinePick] = useState<PLLinePick | null>(null);
  const openLine = (line: string | undefined, label: string) => (line ? () => setLinePick({ line, label, from, to, basis }) : undefined);
  const cur = data?.currency ?? "AED";

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
        <div className="ml-auto flex items-center gap-2">
          <span className="text-sm text-foreground-muted">Count income by</span>
          <div role="radiogroup" aria-label="Count income by" className="inline-flex overflow-hidden rounded-md border border-border">
            {BASES.map((b) => (
              <button
                key={b.key} type="button" role="radio" aria-checked={basis === b.key} onClick={() => setBasis(b.key)}
                className={`px-3 py-1.5 text-sm transition-colors ${basis === b.key ? "bg-primary text-primary-foreground font-medium" : "text-foreground-muted hover:bg-surface-muted"}`}
              >
                {b.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Both bases side by side, whichever is shown — and what is still owed on the period's invoices. */}
      {data?.bases && (
        <div className="flex flex-wrap gap-x-6 gap-y-1 rounded-lg border border-border bg-surface px-4 py-3 text-sm text-foreground-muted">
          <span>Invoiced, before VAT: <MoneyDisplay minor={data.bases.invoicedMinor} className="font-medium text-foreground" /></span>
          <span>Collected: <MoneyDisplay minor={data.bases.collectedMinor} className="font-medium text-foreground" /></span>
          <span>Still owed on this period&apos;s invoices: <MoneyDisplay minor={data.bases.owedMinor} className="font-medium text-foreground" /></span>
        </div>
      )}

      {/* Summary cards */}
      <div className="grid gap-4 sm:grid-cols-3">
        {[
          { label: collected ? "Total Income (collected)" : "Total Income", note: collected ? "Payments received" : "Invoices issued, before VAT", value: data?.income.total ?? 0, color: "text-success" },
          { label: "Total Expenses", note: collected ? "Paid in the period" : "Dated in the period", value: data?.expenses.total ?? 0, color: "text-danger" },
          { label: collected ? "Net Profit (cash)" : "Net Profit", note: "Income less expenses", value: netProfit, color: netProfit >= 0 ? "text-success" : "text-danger" },
        ].map((card) => (
          <div key={card.label} className="rounded-xl border border-border bg-surface p-5">
            <p className="text-sm text-foreground-muted">{card.label}</p>
            {isLoading ? (
              <div className="mt-1 h-8 w-32 animate-pulse rounded bg-surface-muted" />
            ) : (
              <MoneyDisplay minor={card.value} className={`mt-1 text-2xl font-bold ${card.color}`} />
            )}
            <p className="mt-1 text-xs text-foreground-subtle">{card.note}</p>
          </div>
        ))}
      </div>

      {/* Income in another currency than the organization's (2026-11-27: "show INR income separate instead of summing on
          AED") — rupees paid on AED invoices, and invoices in another currency: apart, as paid, out of Total Income and
          Net Profit. One box per currency, like the expenses below. */}
      {!isLoading && !!data?.income.otherCurrencies?.length && (
        <div className="rounded-xl border border-warning/40 bg-surface p-5">
          <h3 className="font-semibold">Income in other currencies</h3>
          <p className="mt-1 text-sm text-foreground-muted">
            {collected ? "Payments received" : "Paid on this period's invoices"} in a currency other than this organization&apos;s. Not in Total Income or Net Profit, and never converted.
          </p>
          <div className="mt-4 grid gap-6 sm:grid-cols-2">
            {Object.values(data.income.otherCurrencies.reduce<Record<string, { currency: string; amountMinor: number; count: number }>>((by, l) => {
              const t = (by[l.currency] ??= { currency: l.currency, amountMinor: 0, count: 0 });
              t.amountMinor += l.amountMinor;
              t.count += l.count;
              return by;
            }, {})).map((other) => (
              <div key={other.currency} className="flex flex-wrap items-baseline justify-between gap-x-2">
                <MoneyDisplay minor={other.amountMinor} currency={other.currency} className="text-xl font-bold tabular-nums text-warning" />
                <span className="text-xs text-foreground-muted">
                  {other.count.toLocaleString()} {other.count === 1 ? "record" : "records"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Expenses and supplier bills in another currency than the organization's (2026-11-26: rupees were added into
          the dirham total): apart, as recorded — not in the cards above, the breakdown below or the net profit. */}
      {!isLoading && !!data?.expenses.otherCurrencies?.length && (
        <div className="rounded-xl border border-warning/40 bg-surface p-5">
          <h3 className="font-semibold">Expenses in other currencies</h3>
          <p className="mt-1 text-sm text-foreground-muted">
            Recorded in a currency other than this organization&apos;s. They are not in Total Expenses or Net Profit, and are never converted.
          </p>
          <div className="mt-4 grid gap-6 sm:grid-cols-2">
            {data.expenses.otherCurrencies.map((other) => (
              <div key={other.currency}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                  <MoneyDisplay minor={other.amountMinor} currency={other.currency} className="text-xl font-bold tabular-nums text-warning" />
                  <span className="text-xs text-foreground-muted">
                    {other.count.toLocaleString()} {other.count === 1 ? "record" : "records"}
                  </span>
                </div>
                {other.breakdown.map((item) => (
                  <div key={item.label} className="flex items-center justify-between py-1.5 pl-4">
                    <span className="text-sm text-foreground-muted">{item.label}</span>
                    <MoneyDisplay minor={item.amountMinor} currency={other.currency} className="text-sm" />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

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
              <PLRow key={item.label} label={item.label} amountMinor={item.amountMinor} indent onOpen={openLine(item.key, collected ? "Income collected" : "Invoice revenue")} />
            ))}
            <PLRow label="Total Income" amountMinor={data.income.total} bold onOpen={openLine("income", "Total income")} />
          </div>

          {/* Expenses */}
          <div className="rounded-xl border border-border bg-surface p-5">
            <h3 className="font-semibold mb-3">Expenses</h3>
            {data.expenses.breakdown.map((item) => (
              <PLRow key={item.label} label={item.label} amountMinor={item.amountMinor} indent onOpen={openLine(item.key, item.label)} />
            ))}
            <PLRow label="Total Expenses" amountMinor={data.expenses.total} bold onOpen={openLine("expenses", "Total expenses")} />
          </div>
        </div>
      )}

      {/* Net profit */}
      {!isLoading && data && (
        <div className={`rounded-xl border p-5 ${netProfit >= 0 ? "border-success/30 bg-success/5" : "border-danger/30 bg-danger/5"}`}>
          <div className="flex items-center justify-between">
            <span className="font-semibold text-foreground">{collected ? "Net Profit / (Loss), cash" : "Net Profit / (Loss)"}</span>
            <MoneyDisplay minor={netProfit} className={`text-xl font-bold ${netProfit >= 0 ? "text-success" : "text-danger"}`} />
          </div>
          <p className="mt-1 text-xs text-foreground-muted">{from} → {to}</p>
        </div>
      )}

      <PLLineDialog pick={linePick} onClose={() => setLinePick(null)} money={(m) => formatMoney(m, cur)} />
    </div>
  );
}
