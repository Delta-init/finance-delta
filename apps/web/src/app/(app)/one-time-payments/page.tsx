"use client";

import { useState } from "react";
import Link from "next/link";
import { Banknote, Check, X, Loader2, Send, AlertTriangle } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { MoneyDisplay } from "@/components/ui/money";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/lib/toast";
import { useOneTimePayments, useMarkOneTimePaid, useRejectOneTimePayment, type OneTimePaymentRequest } from "@/features/one-time-payments/api";
import { useExpenseCategories } from "@/features/expense-categories/api";
import { useAllDepartments } from "@/features/departments/api";
import { PayoutFields, emptyPayout, payoutValid, type Payout } from "@/features/hrms-payouts/payout-fields";

/** Radix reads "" as unset, so "no department" needs a value of its own. */
const NO_DEPARTMENT = "__none__";

/**
 * One-time payments from HRMS — a bonus or commission HR sent for finance to
 * pay directly rather than putting on a payslip. The amount is HR's. "Mark
 * paid" records a paid expense — when, how, the bank reference — and HRMS
 * shows the payment as Paid to the employee.
 */
export default function OneTimePaymentsPage() {
  const { data, isLoading, error } = useOneTimePayments();
  const rows = data ?? [];

  return (
    <div className="space-y-4 p-4 md:p-6">
      <PageHeader
        icon={Banknote}
        title="One-time payments"
        description="Bonuses and other one-off payments HR sent from HRMS for finance to pay directly. They are not on any payslip — marking one paid records it as a paid expense."
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
          <Banknote className="mx-auto mb-3 h-8 w-8 opacity-40" />
          Nothing is waiting to be paid.
        </Card>
      ) : (
        <div className="space-y-4">
          {rows.map((r) => <PaymentCard key={`${r.hrmsOrgId}:${r._id}`} payment={r} />)}
        </div>
      )}
    </div>
  );
}

function PaymentCard({ payment: r }: { payment: OneTimePaymentRequest }) {
  const categories = useExpenseCategories();
  const departments = useAllDepartments();
  const markPaid = useMarkOneTimePaid();
  const reject = useRejectOneTimePayment();

  const [category, setCategory] = useState<string | null>(null);
  const [department, setDepartment] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [payout, setPayout] = useState<Payout>(emptyPayout);

  const categoryList = categories.data ?? [];
  const chosenCategory = category ?? (categoryList.some((c) => c.slug === "salaries_wages") ? "salaries_wages" : categoryList[0]?.slug ?? "");
  const departmentList = departments.data ?? [];
  const suggested = r.suggestedDepartmentId && departmentList.some((d) => d.id === r.suggestedDepartmentId) ? r.suggestedDepartmentId : NO_DEPARTMENT;
  const chosenDepartment = department ?? suggested;
  const busy = markPaid.isPending || reject.isPending;
  const currency = (r.employee?.currency || "AED").toUpperCase();

  const made = r.expense && r.expense.status !== "voided" ? r.expense : null;
  const voided = r.expense?.status === "voided" ? r.expense : null;
  const id = (field: string) => `one-time-${r._id}-${field}`;

  const onPaid = async () => {
    const res = await markPaid.mutateAsync({
      id: r._id,
      hrmsOrgId: r.hrmsOrgId,
      note: note.trim(),
      ...payout,
      ...(made ? {} : { category: chosenCategory, departmentId: chosenDepartment === NO_DEPARTMENT ? "" : chosenDepartment }),
    });
    toast.success(`Paid — ${res.expense.expenseNumber} recorded, and the employee has been told`);
  };

  const onReject = async () => {
    await reject.mutateAsync({ id: r._id, hrmsOrgId: r.hrmsOrgId, note: note.trim() });
    toast.success("Rejected — HR and the employee have been told");
  };

  const facts = [r.employee?.employeeCode, r.employee?.designation, r.employee?.department?.name, `For ${r.month}`].filter(Boolean);

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h3 className="text-base font-semibold">{r.label} · {r.employee?.name ?? "Employee"}</h3>
          {facts.length > 0 && <p className="text-sm text-foreground-muted">{facts.join(" · ")}</p>}
          {r.notes && <p className="text-sm">{r.notes}</p>}
          {r.createdBy?.name && <p className="pt-1 text-xs text-foreground-muted">Raised in HR by <span className="text-foreground">{r.createdBy.name}</span></p>}
        </div>
        <div className="shrink-0 sm:text-right">
          <p className="text-xs font-medium uppercase tracking-wide text-foreground-muted">Amount</p>
          <MoneyDisplay minor={Math.round(r.amount * 100)} currency={currency} className="text-lg font-semibold" />
        </div>
      </div>

      {made && (
        <div className="mx-5 mb-5 flex items-start gap-2 rounded-md border border-primary/40 bg-primary/5 p-3 text-sm">
          <Send className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <span>
            <Link href={`/expenses/${made.id}`} className="font-medium text-primary underline-offset-2 hover:underline">{made.expenseNumber}</Link>{" "}
            has been recorded for this payment, but HRMS has not been told yet. Send it again — no second expense is made.
          </span>
        </div>
      )}
      {voided && (
        <div className="mx-5 mb-5 flex items-start gap-2 rounded-md border border-danger/30 bg-danger/5 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
          <span>{voided.expenseNumber} was recorded for this payment and then voided. Reject it instead.</span>
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
              <Button onClick={() => void onPaid().catch(() => undefined)} disabled={busy || (!made && (!chosenCategory || !payoutValid(payout)))}>
                {markPaid.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : made ? <Send className="h-4 w-4" /> : <Check className="h-4 w-4" />}
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
