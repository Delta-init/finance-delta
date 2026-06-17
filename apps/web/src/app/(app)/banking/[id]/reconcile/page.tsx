"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, CheckCircle2, AlertCircle, RefreshCw } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { type BankTransaction } from "@delta/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyDisplay } from "@/components/ui/money";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/lib/toast";
import { ApiError } from "@/lib/api";
import {
  useBankAccount,
  useBankTransactions,
  useStartReconciliation,
  useUpdateReconciliation,
  useCompleteReconciliation,
  useReconciliations,
} from "@/features/banking/api";

const startSchema = z.object({
  statementDate: z.string().min(1, "Statement date is required"),
  statementBalanceDisplay: z.string().min(1, "Statement balance is required"),
  notes: z.string().optional(),
});
type StartFormValues = z.infer<typeof startSchema>;

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

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<StartFormValues>({
    resolver: zodResolver(startSchema),
    defaultValues: { statementDate: new Date().toISOString().slice(0, 10) },
  });

  async function onStart(values: StartFormValues) {
    try {
      await startReconciliation.mutateAsync({
        statementDate: values.statementDate,
        statementBalanceMinor: toMinor(values.statementBalanceDisplay),
        notes: values.notes ?? "",
      });
      toast.success("Reconciliation session started");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to start reconciliation");
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
          Enter the closing balance from your bank statement. Then check off transactions that appear on the statement.
        </p>

        <form onSubmit={handleSubmit(onStart)} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="statementDate">Statement Date *</Label>
              <Input id="statementDate" type="date" {...register("statementDate")} />
              {errors.statementDate && <p className="text-xs text-danger">{errors.statementDate.message}</p>}
            </div>
            <div className="space-y-1">
              <Label htmlFor="statementBalanceDisplay">
                Statement Balance ({account?.currency ?? "AED"}) *
              </Label>
              <Input
                id="statementBalanceDisplay"
                type="number"
                step="0.01"
                {...register("statementBalanceDisplay")}
                placeholder="0.00"
              />
              {errors.statementBalanceDisplay && (
                <p className="text-xs text-danger">{errors.statementBalanceDisplay.message}</p>
              )}
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="notes">Notes</Label>
            <Input id="notes" {...register("notes")} placeholder="Optional notes…" />
          </div>

          <div className="flex justify-end">
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Starting…" : "Start Reconciliation"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ActiveReconciliation({
  accountId,
  session,
}: {
  accountId: string;
  session: { id: string; statementBalanceMinor: number; openingBookBalanceMinor: number; closingBookBalanceMinor: number; differenceMinor: number; currency: string; statementDate: string; reconciledTransactionIds: string[]; status: string };
}) {
  const router = useRouter();
  const { data: txData } = useBankTransactions(accountId, {
    page: 1,
    pageSize: 100,
    isReconciled: "false",
  });
  const updateReconciliation = useUpdateReconciliation(accountId, session.id);
  const completeReconciliation = useCompleteReconciliation(accountId, session.id);
  const [selected, setSelected] = useState<Set<string>>(
    new Set(session.reconciledTransactionIds),
  );

  const transactions = txData?.data ?? [];

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

  async function handleSave() {
    try {
      await updateReconciliation.mutateAsync({
        reconciledTransactionIds: Array.from(selected),
      });
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
          <p className="text-sm text-foreground-muted">Statement date: {session.statementDate}</p>
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
            Unreconciled Transactions
            <span className="ml-2 text-xs font-normal text-foreground-muted">
              {selected.size} of {transactions.length} checked
            </span>
          </p>
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
                <th className="px-4 py-2.5 text-left text-xs font-medium text-foreground-muted">Description</th>
                <th className="px-4 py-2.5 text-right text-xs font-medium text-foreground-muted">Amount</th>
              </tr>
            </thead>
            <tbody>
              {transactions.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-foreground-muted text-sm">
                    No unreconciled transactions
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
