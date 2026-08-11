"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Repeat, Plus, ArrowLeft, Pause, Play, CircleStop, CalendarClock, Layers, PauseCircle, Wallet,
} from "lucide-react";
import { EXPENSE_CATEGORY_LABELS, type Expense, type ExpenseCategory } from "@delta/shared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MoneyDisplay } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { Card } from "@/components/ui/card";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useCurrency } from "@/lib/currency-context";
import {
  useExpenses,
  usePauseRecurrence,
  useResumeRecurrence,
  useStopRecurrence,
} from "@/features/expenses/api";

const FREQ_LABEL: Record<string, string> = {
  weekly: "Weekly",
  monthly: "Monthly",
  quarterly: "Quarterly",
  yearly: "Yearly",
};

/** Normalise a recurring charge to a monthly-equivalent amount, so schedules on
 *  different frequencies can be summed into one "committed monthly spend". */
function monthlyEquivalent(totalMinor: number, frequency: string): number {
  switch (frequency) {
    case "weekly": return Math.round((totalMinor * 52) / 12);
    case "quarterly": return Math.round(totalMinor / 3);
    case "yearly": return Math.round(totalMinor / 12);
    default: return totalMinor; // monthly
  }
}

export default function RecurringExpensesPage() {
  const { currency, convert } = useCurrency();
  const { data, isLoading } = useExpenses({ isRecurring: "true", pageSize: 100, sort: "date", dir: "desc" });

  const items = data?.data ?? [];
  const active = items.filter((e) => e.recurrence?.isActive !== false);
  const paused = items.filter((e) => e.recurrence?.isActive === false);
  const monthlyCommitmentMinor = active.reduce(
    (s, e) => s + monthlyEquivalent(e.totalMinor, e.recurrence?.frequency ?? "monthly"),
    0,
  );
  const nextCharge = active
    .map((e) => e.recurrence?.nextDate)
    .filter((d): d is string => !!d)
    .sort()[0];

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link
            href="/expenses"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-foreground-muted transition-colors hover:bg-surface-muted hover:text-foreground"
            aria-label="Back to expenses"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary-50 text-primary-700">
            <Repeat className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Recurring Expenses</h1>
            <p className="text-sm text-foreground-muted">Scheduled expenses that generate automatically.</p>
          </div>
        </div>
        <Link href="/expenses/new">
          <Button><Plus className="h-4 w-4" /> New recurring expense</Button>
        </Link>
      </div>

      {/* KPI cards */}
      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Card key={i} className="p-5"><Skeleton className="h-3 w-28" /><Skeleton className="mt-3 h-7 w-32" /></Card>
          ))}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Card className="p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-foreground-muted flex items-center gap-1.5">
              <Layers className="h-3.5 w-3.5" /> Active schedules
            </p>
            <p className="mt-2 text-2xl font-bold font-numeric">{active.length}</p>
          </Card>
          <Card className="p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-foreground-muted flex items-center gap-1.5">
              <PauseCircle className="h-3.5 w-3.5" /> Paused
            </p>
            <p className="mt-2 text-2xl font-bold font-numeric text-warning">{paused.length}</p>
          </Card>
          <Card className="p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-foreground-muted flex items-center gap-1.5">
              <Wallet className="h-3.5 w-3.5" /> Monthly commitment
            </p>
            <p className="mt-2 text-2xl font-bold font-numeric">
              {`${currency} ${(convert(monthlyCommitmentMinor) / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`}
            </p>
            <p className="mt-1 text-xs text-foreground-subtle">active schedules, normalised to /month</p>
          </Card>
          <Card className="p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-foreground-muted flex items-center gap-1.5">
              <CalendarClock className="h-3.5 w-3.5" /> Next charge
            </p>
            <p className="mt-2 text-2xl font-bold font-numeric">{nextCharge ?? "—"}</p>
          </Card>
        </div>
      )}

      {/* Table */}
      <Card className="overflow-hidden p-0">
        {isLoading ? (
          <div className="space-y-3 p-6">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <Repeat className="h-10 w-10 text-foreground-subtle" />
            <p className="text-sm font-medium">No recurring expenses yet</p>
            <p className="text-xs text-foreground-muted">Turn on “Recurring” when creating an expense to schedule it.</p>
            <Link href="/expenses/new" className="mt-1">
              <Button size="sm"><Plus className="h-4 w-4" /> New recurring expense</Button>
            </Link>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-muted text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                  <th className="px-4 py-3 text-left">Expense</th>
                  <th className="px-4 py-3 text-left">Category</th>
                  <th className="px-4 py-3 text-left">Frequency</th>
                  <th className="px-4 py-3 text-left">Next charge</th>
                  <th className="px-4 py-3 text-left">Ends</th>
                  <th className="px-4 py-3 text-right">Amount</th>
                  <th className="px-4 py-3 text-left">State</th>
                  <th className="px-4 py-3 text-right">Manage</th>
                </tr>
              </thead>
              <tbody>
                {items.map((e) => <RecurringRow key={e.id} expense={e} />)}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function RecurringRow({ expense }: { expense: Expense }) {
  const router = useRouter();
  const pause = usePauseRecurrence(expense.id);
  const resume = useResumeRecurrence(expense.id);
  const stop = useStopRecurrence(expense.id);
  const rec = expense.recurrence;
  const isPaused = rec?.isActive === false;

  async function run(action: () => Promise<unknown>, msg: string) {
    try { await action(); toast.success(msg); }
    catch (e) { toast.error(e instanceof ApiError ? e.message : "Action failed"); }
  }

  return (
    <tr className="border-b border-border last:border-0 hover:bg-surface-muted/50 transition-colors">
      <td className="px-4 py-3">
        <Link href={`/expenses/${expense.id}`} className="font-medium hover:text-primary hover:underline">
          {expense.description}
        </Link>
        <span className="block font-mono text-xs text-foreground-subtle">{expense.expenseNumber}</span>
      </td>
      <td className="px-4 py-3 text-foreground-muted">
        {EXPENSE_CATEGORY_LABELS[expense.category as ExpenseCategory] ?? expense.category}
      </td>
      <td className="px-4 py-3">{FREQ_LABEL[rec?.frequency ?? ""] ?? rec?.frequency}</td>
      <td className="px-4 py-3 font-numeric">{rec?.nextDate ?? "—"}</td>
      <td className="px-4 py-3 font-numeric text-foreground-muted">{rec?.endDate ?? "Ongoing"}</td>
      <td className="px-4 py-3 text-right">
        <MoneyDisplay minor={expense.totalMinor} currency={expense.currency} className="font-medium" />
      </td>
      <td className="px-4 py-3">
        <Badge tone={isPaused ? "warning" : "success"}>{isPaused ? "Paused" : "Active"}</Badge>
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center justify-end gap-1">
          {isPaused ? (
            <Button variant="ghost" size="icon" aria-label="Resume" title="Resume"
              onClick={() => run(() => resume.mutateAsync(undefined), "Resumed")} loading={resume.isPending}>
              <Play className="h-4 w-4 text-success" />
            </Button>
          ) : (
            <Button variant="ghost" size="icon" aria-label="Pause" title="Pause"
              onClick={() => run(() => pause.mutateAsync(undefined), "Paused")} loading={pause.isPending}>
              <Pause className="h-4 w-4 text-warning" />
            </Button>
          )}
          <Button variant="ghost" size="icon" aria-label="Stop" title="Stop"
            onClick={() => run(() => stop.mutateAsync(undefined).then(() => router.refresh()), "Stopped")} loading={stop.isPending}>
            <CircleStop className="h-4 w-4 text-danger" />
          </Button>
        </div>
      </td>
    </tr>
  );
}
