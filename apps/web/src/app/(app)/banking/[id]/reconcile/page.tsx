"use client";

import { use, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, CheckCircle2, AlertCircle, RefreshCw } from "lucide-react";
import { type BankTransaction } from "@delta/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyDisplay } from "@/components/ui/money";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/lib/toast";
import { ApiError } from "@/lib/api";
import { rangeDates } from "@/lib/date-range";
import { cn } from "@/lib/utils";
import {
  useBankAccount,
  useReconciliationLines,
  useReconciliationOpening,
  useStartReconciliation,
  useUpdateReconciliation,
  useCompleteReconciliation,
  useReconciliations,
} from "@/features/banking/api";

/*
 * A reconciliation covers a period (the user, 2026-10-23: "reconcile by a specific date — this month, this week,
 * today"): only that period's unreconciled lines are listed, and the statement's balance at its start (filled in from
 * the last reconciliation or the book) plus the ticked lines must come to its closing balance.
 */
type PeriodKey = "today" | "week" | "month" | "lastMonth" | "custom";
const PERIODS: Array<[PeriodKey, string]> = [["today", "Today"], ["week", "This week"], ["month", "This month"], ["lastMonth", "Last month"], ["custom", "Custom"]];
function periodDates(key: Exclude<PeriodKey, "custom">): { from: string; to: string } {
  if (key !== "lastMonth") return rangeDates(key);
  const { from } = rangeDates("month");
  const first = new Date(`${from}T00:00:00Z`);
  const lastOfPrev = new Date(first.getTime() - 86_400_000);
  const firstOfPrev = new Date(Date.UTC(lastOfPrev.getUTCFullYear(), lastOfPrev.getUTCMonth(), 1));
  return { from: firstOfPrev.toISOString().slice(0, 10), to: lastOfPrev.toISOString().slice(0, 10) };
}
const toDisplay = (minor: number) => (minor / 100).toFixed(2);

function toMinor(val: string): number {
  const n = parseFloat(val);
  return isNaN(n) ? 0 : Math.round(n * 100);
}

export default function ReconcilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { data: account } = useBankAccount(id);
  const { data: sessions } = useReconciliations(id, { page: 1, pageSize: 5 });
  const openSession = sessions?.data.find((s) => s.status === "open");

  const startReconciliation = useStartReconciliation(id);

  const initial = periodDates("month");
  const [period, setPeriod] = useState<PeriodKey>("month");
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [statementDate, setStatementDate] = useState(initial.to);
  const [opening, setOpening] = useState("");
  const [openingTouched, setOpeningTouched] = useState(false);
  const [closing, setClosing] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const { data: suggested } = useReconciliationOpening(id, from);
  // The opening balance follows the period until somebody types one.
  useEffect(() => {
    if (suggested && !openingTouched) setOpening(toDisplay(suggested.openingBalanceMinor));
  }, [suggested, openingTouched]);

  function pickPeriod(key: PeriodKey) {
    setPeriod(key);
    if (key === "custom") return;
    const d = periodDates(key);
    setFrom(d.from);
    setTo(d.to);
    setStatementDate(d.to);
    setOpeningTouched(false);
  }
  const reconciledTo = suggested?.reconciledTo ?? null;
  const overlaps = !!reconciledTo && from <= reconciledTo;
  const invalid = !from || !to || from > to || !statementDate || statementDate < to || closing.trim() === "" || opening.trim() === "" || overlaps;

  async function onStart() {
    if (invalid) return;
    setBusy(true);
    try {
      await startReconciliation.mutateAsync({
        statementDate,
        statementBalanceMinor: toMinor(closing),
        periodFrom: from,
        periodTo: to,
        openingBalanceMinor: toMinor(opening),
        notes,
      });
      toast.success("Reconciliation started");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to start reconciliation");
    } finally {
      setBusy(false);
    }
  }

  if (openSession) {
    return <ActiveReconciliation accountId={id} session={openSession} />;
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Link
          href={`/banking/${id}`}
          className="inline-flex h-9 w-9 items-center justify-center rounded-md text-foreground-muted hover:bg-surface-muted hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div>
          <h1 className="text-xl font-semibold">Bank Reconciliation</h1>
          <p className="text-sm text-foreground-muted">
            {account ? `${account.accountName} · ${account.currency}` : "Loading…"}
          </p>
        </div>
      </div>

      {/* Previous sessions */}
      {sessions && sessions.data.filter((s) => s.status === "completed").length > 0 && (
        <div className="rounded-lg border border-border bg-surface overflow-hidden">
          <div className="px-4 py-3 border-b border-border">
            <p className="text-sm font-semibold">Previous Reconciliations</p>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-surface-muted">
              <tr>
                <th className="px-4 py-2 text-left text-xs font-medium text-foreground-muted">Period</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-foreground-muted">Statement Date</th>
                <th className="px-4 py-2 text-right text-xs font-medium text-foreground-muted">Statement Balance</th>
                <th className="px-4 py-2 text-right text-xs font-medium text-foreground-muted">Difference</th>
                <th className="px-4 py-2 text-xs font-medium text-foreground-muted">Completed By</th>
              </tr>
            </thead>
            <tbody>
              {sessions.data
                .filter((s) => s.status === "completed")
                .map((s) => (
                  <tr key={s.id} className="border-t border-border">
                    <td className="px-4 py-2.5 text-foreground-muted">{s.periodFrom && s.periodTo ? `${s.periodFrom} → ${s.periodTo}` : "—"}</td>
                    <td className="px-4 py-2.5 text-foreground-muted">{s.statementDate}</td>
                    <td className="px-4 py-2.5 text-right">
                      <MoneyDisplay minor={s.statementBalanceMinor} currency={s.currency} />
                    </td>
                    <td className={`px-4 py-2.5 text-right font-medium ${s.differenceMinor === 0 ? "text-success" : "text-danger"}`}>
                      {s.differenceMinor === 0 ? "Balanced" : <MoneyDisplay minor={s.differenceMinor} currency={s.currency} />}
                    </td>
                    <td className="px-4 py-2.5 text-foreground-muted text-xs">{s.completedByName ?? "—"}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Start new session */}
      <div className="rounded-lg border border-border bg-surface p-6 space-y-4">
        <h2 className="text-sm font-semibold text-foreground-muted uppercase tracking-wide">Start New Reconciliation</h2>
        <p className="text-sm text-foreground-muted">
          Pick the period the statement covers, then enter its balances. Only that period&apos;s unreconciled lines are listed to tick.
        </p>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Period</Label>
            <div className="inline-flex flex-wrap rounded-lg border border-border bg-surface p-0.5" role="tablist" aria-label="Period">
              {PERIODS.map(([key, label]) => (
                <button key={key} type="button" role="tab" aria-selected={period === key} onClick={() => pickPeriod(key)}
                  className={cn("rounded-md px-3 py-1.5 text-sm", period === key ? "bg-primary text-primary-foreground" : "text-foreground-muted hover:text-foreground")}>
                  {label}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-4 pt-1">
              <div className="space-y-1">
                <Label htmlFor="periodFrom">From</Label>
                <Input id="periodFrom" type="date" value={from} onChange={(e) => { setPeriod("custom"); setFrom(e.target.value); setOpeningTouched(false); }} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="periodTo">To</Label>
                <Input id="periodTo" type="date" value={to} min={from} onChange={(e) => { setPeriod("custom"); setTo(e.target.value); if (statementDate < e.target.value) setStatementDate(e.target.value); }} />
              </div>
            </div>
            {reconciledTo && (
              <p className={cn("text-xs", overlaps ? "text-danger" : "text-foreground-muted")}>
                Reconciled up to {reconciledTo}{overlaps ? " — start the period after that day" : ""}.
              </p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="openingBalance">Opening balance ({account?.currency ?? "AED"}) *</Label>
              <Input id="openingBalance" type="number" step="0.01" value={opening} onChange={(e) => { setOpening(e.target.value); setOpeningTouched(true); }} placeholder="0.00" />
              <p className="text-xs text-foreground-muted">
                {suggested?.source === "last_reconciliation" ? "From the last reconciliation's closing balance" : "From the book on the day before — change it to the statement's own figure"}
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="statementBalanceDisplay">Closing balance ({account?.currency ?? "AED"}) *</Label>
              <Input id="statementBalanceDisplay" type="number" step="0.01" value={closing} onChange={(e) => setClosing(e.target.value)} placeholder="0.00" />
              <p className="text-xs text-foreground-muted">The statement&apos;s balance at the end of the period</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="statementDate">Statement date *</Label>
              <Input id="statementDate" type="date" value={statementDate} min={to} onChange={(e) => setStatementDate(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="notes">Notes</Label>
              <Input id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional notes…" />
            </div>
          </div>
          <div className="flex justify-end">
            <Button type="button" onClick={onStart} disabled={invalid || busy}>
              {busy ? "Starting…" : "Start Reconciliation"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ActiveReconciliation({
  accountId,
  session,
}: {
  accountId: string;
  session: { id: string; statementBalanceMinor: number; openingBookBalanceMinor: number; closingBookBalanceMinor: number; differenceMinor: number; currency: string; statementDate: string; reconciledTransactionIds: string[]; statementDates?: Record<string, string>; periodFrom?: string; periodTo?: string; status: string };
}) {
  const router = useRouter();
  // The period's unreconciled lines — all of them — and what is ticked; earlier ones only when asked (2026-10-23).
  const [earlier, setEarlier] = useState(false);
  const { data: lines, isLoading: linesLoading } = useReconciliationLines(accountId, session.id, earlier);
  const updateReconciliation = useUpdateReconciliation(accountId, session.id);
  const completeReconciliation = useCompleteReconciliation(accountId, session.id);
  const [selected, setSelected] = useState<Set<string>>(
    new Set(session.reconciledTransactionIds),
  );
  /* The day the statement shows each ticked line, where it isn't the line's own date (the user, 2026-10-23): the
     line — and the expense it pays — takes it when the reconciliation is completed. */
  const [dates, setDates] = useState<Record<string, string>>(session.statementDates ?? {});

  const transactions = lines ?? [];
  const shown = useMemo(() => {
    let debits = 0, credits = 0;
    for (const tx of transactions) { if (tx.amountMinor < 0) debits += -tx.amountMinor; else credits += tx.amountMinor; }
    return { debits, credits };
  }, [transactions]);

  function toggle(txId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(txId)) next.delete(txId);
      else next.add(txId);
      return next;
    });
  }

  const selectedTxs = transactions.filter((tx) => selected.has(tx.id));
  const selectedTotal = selectedTxs.reduce((sum, tx) => sum + tx.amountMinor, 0);
  const closingBookBalance = session.openingBookBalanceMinor + selectedTotal;
  const difference = session.statementBalanceMinor - closingBookBalance;
  const isBalanced = difference === 0;

  /** What is ticked, with the statement dates given for those lines. */
  function progress() {
    const statementDates: Record<string, string> = {};
    for (const tx of transactions) {
      const d = dates[tx.id];
      if (selected.has(tx.id) && d && d !== tx.date) statementDates[tx.id] = d;
    }
    return { reconciledTransactionIds: Array.from(selected), statementDates };
  }

  async function handleSave() {
    try {
      await updateReconciliation.mutateAsync(progress());
      toast.success("Progress saved");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to save");
    }
  }

  async function handleComplete() {
    if (!isBalanced) {
      toast.error("Cannot complete — difference must be zero");
      return;
    }
    try {
      // What is on screen — the ticks and the statement dates — is saved first, so nothing typed since the last
      // save is lost.
      await updateReconciliation.mutateAsync(progress());
      await completeReconciliation.mutateAsync();
      toast.success("Reconciliation completed");
      router.push(`/banking/${accountId}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to complete reconciliation");
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      <div className="flex items-center gap-3">
        <Link
          href={`/banking/${accountId}`}
          className="inline-flex h-9 w-9 items-center justify-center rounded-md text-foreground-muted hover:bg-surface-muted hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold">Reconciliation in Progress</h1>
            <Badge tone="warning">Open</Badge>
          </div>
          <p className="text-sm text-foreground-muted">
            {session.periodFrom && session.periodTo ? `Period ${session.periodFrom} → ${session.periodTo} · ` : ""}Statement date: {session.statementDate}
          </p>
        </div>
      </div>

      {/* Balance summary */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="text-xs font-medium text-foreground-muted uppercase tracking-wide">Statement Balance</p>
          <MoneyDisplay minor={session.statementBalanceMinor} currency={session.currency} className="mt-1 text-lg font-bold text-foreground" />
        </div>
        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="text-xs font-medium text-foreground-muted uppercase tracking-wide">Opening Book Balance</p>
          <MoneyDisplay minor={session.openingBookBalanceMinor} currency={session.currency} className="mt-1 text-lg font-semibold text-foreground" />
        </div>
        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="text-xs font-medium text-foreground-muted uppercase tracking-wide">Checked Total</p>
          <MoneyDisplay minor={closingBookBalance} currency={session.currency} className="mt-1 text-lg font-semibold text-foreground" />
        </div>
        <div className={`rounded-lg border p-4 ${isBalanced ? "border-success/30 bg-success/5" : "border-danger/30 bg-danger/5"}`}>
          <p className="text-xs font-medium text-foreground-muted uppercase tracking-wide">Difference</p>
          <div className="mt-1 flex items-center gap-2">
            {isBalanced ? (
              <CheckCircle2 className="h-5 w-5 text-success" />
            ) : (
              <AlertCircle className="h-5 w-5 text-danger" />
            )}
            <MoneyDisplay
              minor={Math.abs(difference)}
              currency={session.currency}
              className={`text-lg font-bold ${isBalanced ? "text-success" : "text-danger"}`}
            />
          </div>
          <p className="text-xs mt-1 text-foreground-muted">{isBalanced ? "Balanced!" : difference > 0 ? "Under by" : "Over by"}</p>
        </div>
      </div>

      {/* Transaction list */}
      <div className="rounded-lg border border-border bg-surface overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <p className="text-sm font-semibold">
            {session.periodFrom ? "Unreconciled lines in the period" : "Unreconciled Transactions"}
            <span className="ml-2 text-xs font-normal text-foreground-muted">
              {selected.size} of {transactions.length} checked · out <MoneyDisplay minor={shown.debits} currency={session.currency} /> · in <MoneyDisplay minor={shown.credits} currency={session.currency} />
            </span>
          </p>
          {session.periodFrom && (
            <label className="flex items-center gap-2 text-xs text-foreground-muted">
              <input type="checkbox" checked={earlier} onChange={(e) => setEarlier(e.target.checked)} className="rounded border-border" />
              Show earlier unreconciled lines
            </label>
          )}
          <button
            onClick={() => {
              if (selected.size === transactions.length) {
                setSelected(new Set());
              } else {
                setSelected(new Set(transactions.map((tx) => tx.id)));
              }
            }}
            className="text-xs text-primary hover:underline"
          >
            {selected.size === transactions.length ? "Uncheck all" : "Check all"}
          </button>
        </div>
        <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface-muted">
              <tr>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-foreground-muted w-10"></th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-foreground-muted">Date</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-foreground-muted" title="The day the bank statement shows it — the line's own date unless you change it">Statement date</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-foreground-muted">Description</th>
                <th className="px-4 py-2.5 text-right text-xs font-medium text-foreground-muted">Amount</th>
              </tr>
            </thead>
            <tbody>
              {transactions.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-foreground-muted text-sm">
                    {linesLoading ? "Loading…" : "No unreconciled transactions"}
                  </td>
                </tr>
              )}
              {transactions.map((tx) => (
                <tr
                  key={tx.id}
                  className={`border-t border-border cursor-pointer transition-colors ${
                    selected.has(tx.id) ? "bg-primary/5" : "hover:bg-surface-muted/50"
                  }`}
                  onClick={() => toggle(tx.id)}
                >
                  <td className="px-4 py-2.5">
                    <input
                      type="checkbox"
                      checked={selected.has(tx.id)}
                      onChange={() => toggle(tx.id)}
                      onClick={(e) => e.stopPropagation()}
                      className="rounded border-border"
                    />
                  </td>
                  <td className="px-4 py-2.5 text-foreground-muted">{tx.date}</td>
                  <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                    {selected.has(tx.id) ? (
                      <input
                        type="date"
                        aria-label={`Statement date for ${tx.description}`}
                        value={dates[tx.id] ?? tx.date}
                        max={session.statementDate}
                        onChange={(e) => setDates((prev) => ({ ...prev, [tx.id]: e.target.value || tx.date }))}
                        className={`h-8 rounded-md border bg-surface px-2 text-xs ${dates[tx.id] && dates[tx.id] !== tx.date ? "border-primary text-foreground" : "border-border text-foreground-muted"}`}
                      />
                    ) : (
                      <span className="text-xs text-foreground-subtle">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <p className="font-medium text-foreground max-w-xs truncate">{tx.description}</p>
                    {tx.reference && <p className="text-xs text-foreground-muted">{tx.reference}</p>}
                  </td>
                  <td className={`px-4 py-2.5 text-right font-mono font-medium ${tx.amountMinor >= 0 ? "text-success" : "text-danger"}`}>
                    {tx.amountMinor >= 0 ? "+" : ""}
                    {(tx.amountMinor / 100).toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex items-center justify-end gap-3">
        <Button variant="outline" onClick={handleSave} disabled={updateReconciliation.isPending}>
          <RefreshCw className="h-4 w-4" />
          {updateReconciliation.isPending ? "Saving…" : "Save Progress"}
        </Button>
        <Button
          onClick={handleComplete}
          disabled={!isBalanced || completeReconciliation.isPending}
        >
          <CheckCircle2 className="h-4 w-4" />
          {completeReconciliation.isPending ? "Completing…" : "Complete Reconciliation"}
        </Button>
      </div>
    </div>
  );
}
