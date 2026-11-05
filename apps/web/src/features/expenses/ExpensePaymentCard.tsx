"use client";

import Link from "next/link";
import type { Expense, ExpenseBankLine } from "@delta/shared";
import { formatMoney, paymentMethodLabel } from "@delta/shared";
import { ArrowUpRight, Landmark, Wallet } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { usePayrollBreakdown, type PayrollBreakdown } from "./PayrollBreakdown";

/**
 * Where an expense's money went (the user, 2026-11-05: "show the payment record and the linked bank payment here,
 * with a link"): for one a payroll payment posted, that payment — run, account, who recorded it, HRMS — with a link to
 * it on its run; and for every paid one, its line in Banking with a link to it in its account.
 */
export function ExpensePaymentCard({ expense, canPayroll, canBanking }: { expense: Expense; canPayroll: boolean; canBanking: boolean }) {
  const isPayroll = Boolean(expense.payroll);
  const { data: payment } = usePayrollBreakdown(expense.id, isPayroll && canPayroll);
  const lines = expense.bankLines ?? [];
  if (!isPayroll && !lines.length && !expense.paidOn) return null;

  return (
    <div className="rounded-lg border border-border bg-surface p-5 space-y-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold"><Wallet className="h-4 w-4" /> Payment</h2>

      {isPayroll && expense.payroll && (
        payment ? <PayrollPaymentRecord p={payment} /> : (
          <div className="space-y-1 text-sm">
            <p className="text-xs text-foreground-muted">Payroll payment</p>
            <p className="font-medium">{expense.payroll.paymentId} · {expense.payroll.people} {expense.payroll.people === 1 ? "person" : "people"}</p>
            {canPayroll && (
              <Link href={payrollHref(expense.payroll.runId, expense.payroll.paymentId)} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
                Open in payroll <ArrowUpRight className="h-3 w-3" />
              </Link>
            )}
          </div>
        )
      )}

      <div className="space-y-2">
        <p className="flex items-center gap-1.5 text-xs text-foreground-muted"><Landmark className="h-3.5 w-3.5" /> In Banking</p>
        {lines.length ? (
          <div className="divide-y divide-border rounded-lg border border-border">
            {lines.map((l) => <BankLineRow key={l.id} line={l} canBanking={canBanking} />)}
          </div>
        ) : (
          <p className="text-sm text-foreground-muted">
            {expense.bankNote
              ? expense.bankNote
              : expense.paymentAccount
                ? `No line in Banking — ${expense.paymentAccount} is not an account in finance.`
                : "Not paid from an account in finance, so there is no line in Banking."}
          </p>
        )}
      </div>
    </div>
  );
}

function payrollHref(runId: string, paymentId: string) {
  return `/payroll/runs/${runId}#payment-${encodeURIComponent(paymentId)}`;
}

/** The account's page, narrowed to this line: its reference (else its words) on its day. */
function bankHref(l: ExpenseBankLine) {
  const params = new URLSearchParams({ q: l.reference || l.description, from: l.date, to: l.date });
  return `/banking/${l.accountId}?${params.toString()}`;
}

function PayrollPaymentRecord({ p }: { p: PayrollBreakdown }) {
  const people = p.people ?? p.rows.length;
  const finished = p.finishedCount ?? p.rows.filter((r) => r.finished).length;
  const part = people - finished;
  const hrms = p.reversed || p.syncedToHrms === undefined
    ? null
    : finished === 0
      ? <Badge tone="warning">Part pay — HRMS waits for the rest</Badge>
      : p.syncedToHrms
        ? <Badge tone="success">Confirmed by HRMS</Badge>
        : <Badge tone="danger" title={p.syncError || undefined}>Not in HRMS</Badge>;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-foreground-muted">Payroll payment</p>
        <Link href={payrollHref(p.runId, p.paymentId)} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
          Open in payroll <ArrowUpRight className="h-3 w-3" />
        </Link>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">{p.paymentId}</span>
        <span className="text-sm font-medium tabular-nums">{formatMoney(p.amountMinor, p.currency)}</span>
        {p.reversed && <Badge tone="danger">Reversed{p.reversalReason ? ` — ${p.reversalReason}` : ""}</Badge>}
        {hrms}
      </div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <Fact label="Payroll run" value={`${p.runNumber} · ${p.period}`} />
        <Fact label="Paid" value={`${p.paidOn} · ${paymentMethodLabel(p.method)}${p.bankAccountName ? ` · ${p.bankAccountName}` : ""}`} />
        <Fact label="People" value={`${people}${part > 0 ? ` (${part} part paid)` : ""}`} />
        {p.reference && <Fact label="Reference" value={p.reference} />}
        {(p.recordedByName || p.recordedAt) && (
          <Fact label="Recorded by" value={[p.recordedByName, p.recordedAt?.slice(0, 10)].filter(Boolean).join(" · ")} />
        )}
        {p.reversedAt && <Fact label="Reversed on" value={p.reversedAt.slice(0, 10)} />}
      </dl>
    </div>
  );
}

function BankLineRow({ line: l, canBanking }: { line: ExpenseBankLine; canBanking: boolean }) {
  return (
    <div className="flex flex-wrap items-start gap-3 px-3 py-2.5 text-sm">
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="font-medium">
          {l.accountName}
          {l.kind === "reversal" && <span className="ml-1.5 text-xs font-normal text-foreground-muted">money back (reversal)</span>}
        </p>
        <p className="text-xs text-foreground-muted break-words">{[l.date, l.description, l.reference && `ref ${l.reference}`].filter(Boolean).join(" · ")}</p>
        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          {l.reconciled
            ? <Badge tone="success">Reconciled{l.statementDate ? ` · statement ${l.statementDate}` : ""}</Badge>
            : <Badge tone="neutral">Not reconciled</Badge>}
          {canBanking && (
            <Link href={bankHref(l)} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
              Open in Banking <ArrowUpRight className="h-3 w-3" />
            </Link>
          )}
        </div>
      </div>
      <span className={`shrink-0 font-semibold tabular-nums ${l.amountMinor < 0 ? "text-danger" : "text-success"}`}>
        {l.amountMinor < 0 ? "−" : "+"}{formatMoney(Math.abs(l.amountMinor), l.currency)}
      </span>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-foreground-muted">{label}</dt>
      <dd className="mt-0.5 font-medium break-words">{value}</dd>
    </div>
  );
}
