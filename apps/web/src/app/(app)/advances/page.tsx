"use client";

import { useState } from "react";
import Link from "next/link";
import { HandCoins, Check, X, Loader2, Send, AlertTriangle } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { MoneyDisplay } from "@/components/ui/money";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/lib/toast";
import { useSalaryAdvances, useApproveAdvance, useRejectAdvance, type SalaryAdvanceRequest } from "@/features/advances/api";
import { useExpenseCategories } from "@/features/expense-categories/api";
import { PayoutFields, emptyPayout, payoutValid, type Payout } from "@/features/hrms-payouts/payout-fields";
import { useAllDepartments } from "@/features/departments/api";

/** Radix reads "" as unset, so "no department" needs a value of its own. */
const NO_DEPARTMENT = "__none__";

/**
 * Salary advances HR has approved in HRMS, waiting on finance.
 *
 * The amount and the recovery are HR's — HRMS takes exactly that back from the
 * employee's pay, on that schedule — so nothing here changes them. "Mark paid"
 * records the payout as a paid expense — the date, the method and the bank
 * reference — and tells HRMS, which shows it Paid and starts the recovery.
 */
export default function AdvancesPage() {
  const { data, isLoading, error } = useSalaryAdvances();
  const rows = data ?? [];

  return (
    <div className="space-y-4 p-4 md:p-6">
      <PageHeader
        icon={HandCoins}
        title="Salary advances"
        description="Advances HR has approved, waiting on finance to pay them. Marking one paid records a paid expense and starts the recovery from pay in HRMS."
        action={rows.length > 0 ? <Badge tone="warning">{rows.length} waiting</Badge> : undefined}
      />

      {isLoading ? (
        <Card className="flex justify-center py-16"><Loader2 className="h-5 w-5 animate-spin text-foreground-muted" /></Card>
      ) : error ? (
        <Card className="px-5 py-12 text-center text-sm text-foreground-muted">
          <AlertTriangle className="mx-auto mb-2 h-6 w-6 text-danger" />
          Could not reach HRMS. Check the integration settings and try again.
        </Card>
      ) : !rows.length ? (
        <Card className="px-5 py-16 text-center text-sm text-foreground-muted">
          <HandCoins className="mx-auto mb-3 h-8 w-8 opacity-40" />
          Nothing is waiting for a decision.
        </Card>
      ) : (
        <div className="space-y-4">
          {rows.map((r) => <AdvanceCard key={`${r.hrmsOrgId}:${r._id}`} advance={r} />)}
        </div>
      )}
    </div>
  );
}

function AdvanceCard({ advance: r }: { advance: SalaryAdvanceRequest }) {
  const categories = useExpenseCategories();
  const departments = useAllDepartments();
  const approve = useApproveAdvance();
  const reject = useRejectAdvance();

  const [category, setCategory] = useState<string | null>(null);
  const [department, setDepartment] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [payout, setPayout] = useState<Payout>(emptyPayout);

  // "Salaries & Wages" when this org has it — an advance is pay, early.
  const categoryList = categories.data ?? [];
  const chosenCategory = category ?? (categoryList.some((c) => c.slug === "salaries_wages") ? "salaries_wages" : categoryList[0]?.slug ?? "");
  const departmentList = departments.data ?? [];
  const suggested = r.suggestedDepartmentId && departmentList.some((d) => d.id === r.suggestedDepartmentId) ? r.suggestedDepartmentId : NO_DEPARTMENT;
  const chosenDepartment = department ?? suggested;
  const busy = approve.isPending || reject.isPending;

  const made = r.expense && r.expense.status !== "voided" ? r.expense : null;
  const voided = r.expense?.status === "voided" ? r.expense : null;
  const id = (field: string) => `advance-${r._id}-${field}`;
  const perMonthMinor = Math.round((r.amount * 100) / Math.max(1, r.months));

  const onApprove = async () => {
    const res = await approve.mutateAsync({
      id: r._id,
      hrmsOrgId: r.hrmsOrgId,
      note: note.trim(),
      ...payout,
      ...(made ? {} : { category: chosenCategory, departmentId: chosenDepartment === NO_DEPARTMENT ? "" : chosenDepartment }),
    });
    toast.success(`Paid — ${res.expense.expenseNumber} recorded, and HRMS will recover it from pay`);
  };

  const onReject = async () => {
    await reject.mutateAsync({ id: r._id, hrmsOrgId: r.hrmsOrgId, note: note.trim() });
    toast.success("Rejected — the employee and HR have been told");
  };

  const facts = [
    r.employee?.employeeCode,
    r.employee?.designation,
    r.employee?.department?.name,
    r.neededBy ? `Needed by ${String(r.neededBy).slice(0, 10)}` : null,
  ].filter(Boolean);

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h3 className="text-base font-semibold">{r.employee?.name ?? "Employee"}</h3>
          {facts.length > 0 && <p className="text-sm text-foreground-muted">{facts.join(" · ")}</p>}
          {r.reason && <p className="text-sm">{r.reason}</p>}
          <div className="flex flex-wrap gap-x-5 gap-y-1 pt-1 text-xs text-foreground-muted">
            <span>
              Recovery: <span className="text-foreground"><MoneyDisplay minor={perMonthMinor} currency={r.currency} /> a month × {r.months}, from {r.startMonth}</span>
            </span>
            <span>Monthly salary: <span className="text-foreground"><MoneyDisplay minor={Math.round(r.monthlySalary * 100)} currency={r.currency} /></span></span>
            {r.hrReviewedBy?.name && <span>Approved by <span className="text-foreground">{r.hrReviewedBy.name}</span></span>}
            {r.hrNote && <span>HR&apos;s note: <span className="text-foreground">{r.hrNote}</span></span>}
          </div>
        </div>
        <div className="shrink-0 sm:text-right">
          <p className="text-xs font-medium uppercase tracking-wide text-foreground-muted">Advance</p>
          <MoneyDisplay minor={Math.round(r.amount * 100)} currency={r.currency} className="text-lg font-semibold" />
        </div>
      </div>

      {made && (
        <div className="mx-5 mb-5 flex items-start gap-2 rounded-md border border-primary/40 bg-primary/5 p-3 text-sm">
          <Send className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <span>
            <Link href={`/expenses/${made.id}`} className="font-medium text-primary underline-offset-2 hover:underline">{made.expenseNumber}</Link>{" "}
            has been recorded for this advance, but HRMS has not been told yet. Send it again — no second expense is made.
          </span>
        </div>
      )}
      {voided && (
        <div className="mx-5 mb-5 flex items-start gap-2 rounded-md border border-danger/30 bg-danger/5 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
          <span>{voided.expenseNumber} was recorded for this advance and then voided. Reject it instead.</span>
        </div>
      )}

      <div className="space-y-4 border-t border-border bg-surface-muted/50 p-5">
        {!made && !voided && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <PayoutFields value={payout} onChange={setPayout} idPrefix={id("payout")} />
            <div className="space-y-1.5">
              <Label htmlFor={id("category")}>Category</Label>
              <Select value={chosenCategory} onValueChange={setCategory} disabled={categories.isLoading}>
                <SelectTrigger id={id("category")}><SelectValue placeholder={categories.isLoading ? "Loading…" : "Choose a category"} /></SelectTrigger>
                <SelectContent>
                  {categoryList.map((c) => <SelectItem key={c.slug} value={c.slug}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={id("department")}>Department (optional)</Label>
              <Select value={chosenDepartment} onValueChange={setDepartment} disabled={departments.isLoading}>
                <SelectTrigger id={id("department")}><SelectValue placeholder="No department" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_DEPARTMENT}>No department</SelectItem>
                  {departmentList.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}

        <div className="flex flex-col gap-4 lg:flex-row lg:items-end">
          <div className="min-w-0 flex-1 space-y-1.5">
            <Label htmlFor={id("note")}>Note (optional)</Label>
            <Input id={id("note")} value={note} maxLength={500} placeholder="Sent to the employee and HR with the decision"
              onChange={(e) => setNote(e.target.value)} />
          </div>
          <div className="flex shrink-0 gap-2">
            {!voided && (
              <Button onClick={() => void onApprove().catch(() => undefined)} disabled={busy || (!made && (!chosenCategory || !payoutValid(payout)))}>
                {approve.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : made ? <Send className="h-4 w-4" /> : <Check className="h-4 w-4" />}
                {made ? "Send to HRMS" : "Mark paid"}
              </Button>
            )}
            <Button variant="outline" onClick={() => void onReject().catch(() => undefined)} disabled={busy || !!made}
              title={made ? `Void ${made.expenseNumber} before rejecting` : undefined}>
              {reject.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}Reject
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}
