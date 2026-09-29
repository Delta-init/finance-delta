"use client";

import { useState } from "react";
import Link from "next/link";
import { ClipboardList, Check, X, Loader2, Send, AlertTriangle } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { MoneyDisplay } from "@/components/ui/money";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/lib/toast";
import {
  useProcurementRequests, useApproveProcurement, useRejectProcurement, type ProcurementRequest,
} from "@/features/procurement/api";
import { useExpenseCategories } from "@/features/expense-categories/api";
import { useAllDepartments } from "@/features/departments/api";

/** Radix reads "" as unset, so "no department" needs a value of its own. */
const NO_DEPARTMENT = "__none__";

/**
 * What HR has approved and finance has not yet decided.
 *
 * Approving records an expense — approved, unpaid — so what is asked for is
 * what an expense needs and HR could not know: the amount being agreed to (HR's
 * is an estimate, and sometimes blank), the expense category, and the
 * department it counts against. The vendor is not asked: most of these are
 * bought before anybody picks one, and "Mark paid" on the expense records how
 * it was actually paid.
 */
export default function ProcurementPage() {
  const { data: requests, isLoading, error } = useProcurementRequests();
  const rows = requests ?? [];

  return (
    <div className="space-y-4 p-4 md:p-6">
      <PageHeader
        icon={ClipboardList}
        title="Procurement"
        description="Purchase requests HR has approved, waiting on the money decision. Approving one records it as an expense."
        action={rows.length > 0 ? <Badge tone="warning">{rows.length} waiting</Badge> : undefined}
      />

      {isLoading ? (
        <Card className="flex justify-center py-16">
          <Loader2 className="h-5 w-5 animate-spin text-foreground-muted" />
        </Card>
      ) : error ? (
        <Card className="px-5 py-12 text-center text-sm text-foreground-muted">
          <AlertTriangle className="mx-auto mb-2 h-6 w-6 text-danger" />
          Could not reach HRMS. Check the integration settings and try again.
        </Card>
      ) : !rows.length ? (
        <Card className="px-5 py-16 text-center text-sm text-foreground-muted">
          <ClipboardList className="mx-auto mb-3 h-8 w-8 opacity-40" />
          Nothing is waiting for a decision.
        </Card>
      ) : (
        <div className="space-y-4">
          {rows.map((r) => <RequestCard key={`${r.hrmsOrgId}:${r._id}`} request={r} />)}
        </div>
      )}
    </div>
  );
}

function RequestCard({ request: r }: { request: ProcurementRequest }) {
  const categories = useExpenseCategories();
  const departments = useAllDepartments();
  const approve = useApproveProcurement();
  const reject = useRejectProcurement();

  const [amount, setAmount] = useState(r.estimatedCost > 0 ? String(r.estimatedCost) : "");
  const [category, setCategory] = useState<string | null>(null);
  const [categoryOther, setCategoryOther] = useState(r.category ?? "");
  const [department, setDepartment] = useState<string | null>(null);
  const [note, setNote] = useState("");

  // Defaults wait for the lists they come from: "Other" when this org has it,
  // and the finance department HR's is linked to, when that still exists.
  const categoryList = categories.data ?? [];
  const chosenCategory = category ?? (categoryList.some((c) => c.slug === "other") ? "other" : categoryList[0]?.slug ?? "");
  const departmentList = departments.data ?? [];
  const suggested = r.suggestedDepartmentId && departmentList.some((d) => d.id === r.suggestedDepartmentId)
    ? r.suggestedDepartmentId : NO_DEPARTMENT;
  const chosenDepartment = department ?? suggested;

  const amountMinor = Math.round(Number(amount) * 100);
  const amountValid = amount.trim() !== "" && Number.isFinite(amountMinor) && amountMinor > 0;
  const busy = approve.isPending || reject.isPending;

  // An expense already recorded for this request stands as it was made; all
  // that is left is telling HR — or, once voided, turning the request down.
  const made = r.expense && r.expense.status !== "voided" ? r.expense : null;
  const voided = r.expense?.status === "voided" ? r.expense : null;
  const id = (field: string) => `procurement-${r._id}-${field}`;

  const onApprove = async () => {
    const res = await approve.mutateAsync({
      id: r._id,
      hrmsOrgId: r.hrmsOrgId,
      note: note.trim(),
      // An expense already recorded is resent as it was made; these only make a new one.
      ...(made ? {} : {
        amountMinor,
        category: chosenCategory,
        categoryOther: chosenCategory === "other" ? categoryOther.trim() : "",
        departmentId: chosenDepartment === NO_DEPARTMENT ? "" : chosenDepartment,
      }),
    });
    toast.success(`Approved — ${res.expense.expenseNumber} recorded, and HR has been told`);
  };

  const onReject = async () => {
    await reject.mutateAsync({ id: r._id, hrmsOrgId: r.hrmsOrgId, note: note.trim() });
    toast.success("Rejected — HR has been told");
  };

  const facts = [
    r.department?.name,
    r.requestedBy?.name ? `Asked by ${r.requestedBy.name}` : null,
    r.neededBy ? `Needed by ${String(r.neededBy).slice(0, 10)}` : null,
  ].filter(Boolean);

  return (
    <Card className="overflow-hidden">
      {/* What was asked for */}
      <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold">{r.quantity} × {r.item}</h3>
            {r.resubmitCount > 0 && <Badge tone="warning">Resubmitted ×{r.resubmitCount}</Badge>}
          </div>
          {facts.length > 0 && <p className="text-sm text-foreground-muted">{facts.join(" · ")}</p>}
          {r.justification && <p className="text-sm">{r.justification}</p>}
          {(r.vendor || r.hrNote) && (
            <div className="flex flex-wrap gap-x-5 gap-y-1 pt-1 text-xs text-foreground-muted">
              {r.vendor && <span>Suggested vendor: <span className="text-foreground">{r.vendor}</span></span>}
              {r.hrNote && <span>HR&apos;s note: <span className="text-foreground">{r.hrNote}</span></span>}
            </div>
          )}
        </div>
        <div className="shrink-0 sm:text-right">
          <p className="text-xs font-medium uppercase tracking-wide text-foreground-muted">HR&apos;s estimate</p>
          {r.estimatedCost > 0 ? (
            <MoneyDisplay minor={Math.round(r.estimatedCost * 100)} currency={r.currency} className="text-lg font-semibold" />
          ) : (
            <p className="text-sm font-medium text-warning">None given</p>
          )}
        </div>
      </div>

      {made && (
        <div className="mx-5 mb-5 flex items-start gap-2 rounded-md border border-primary/40 bg-primary/5 p-3 text-sm">
          <Send className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <span>
            <Link href={`/expenses/${made.id}`} className="font-medium text-primary underline-offset-2 hover:underline">
              {made.expenseNumber}
            </Link>{" "}
            has been recorded for this request, but HR has not been told yet. Approve again to send it — no second
            expense is made.
          </span>
        </div>
      )}
      {voided && (
        <div className="mx-5 mb-5 flex items-start gap-2 rounded-md border border-danger/30 bg-danger/5 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
          <span>
            {voided.expenseNumber} was recorded for this request and then voided. Reject it instead — HR can revise it
            and send it back.
          </span>
        </div>
      )}

      {/* The decision */}
      <div className="space-y-4 border-t border-border bg-surface-muted/50 p-5">
        {!made && !voided && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1.5">
              <Label htmlFor={id("amount")}>Amount ({r.currency})</Label>
              <Input
                id={id("amount")} type="number" inputMode="decimal" min="0" step="0.01" value={amount} placeholder="0.00"
                aria-invalid={amount !== "" && !amountValid}
                onChange={(e) => setAmount(e.target.value)}
              />
              {!amountValid && (
                <p className={r.estimatedCost > 0 ? "text-xs text-foreground-muted" : "text-xs text-warning"}>
                  {r.estimatedCost > 0 ? "Enter an amount above 0." : "HR gave no estimate — enter the amount being approved."}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={id("category")}>Category</Label>
              <Select value={chosenCategory} onValueChange={setCategory} disabled={categories.isLoading}>
                <SelectTrigger id={id("category")}>
                  <SelectValue placeholder={categories.isLoading ? "Loading…" : "Choose a category"} />
                </SelectTrigger>
                <SelectContent>
                  {categoryList.map((c) => <SelectItem key={c.slug} value={c.slug}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {chosenCategory === "other" && (
              <div className="space-y-1.5">
                <Label htmlFor={id("other")}>What it is</Label>
                <Input id={id("other")} value={categoryOther} maxLength={60} placeholder="e.g. Office equipment"
                  onChange={(e) => setCategoryOther(e.target.value)} />
              </div>
            )}
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
            <Label htmlFor={id("note")}>Note to HR (optional)</Label>
            <Input id={id("note")} value={note} maxLength={500} placeholder="Sent back to HR with the decision"
              onChange={(e) => setNote(e.target.value)} />
          </div>
          <div className="flex shrink-0 gap-2">
            {!voided && (
              <Button
                onClick={() => void onApprove().catch(() => undefined)}
                disabled={busy || (!made && (!amountValid || !chosenCategory))}
              >
                {approve.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : made ? <Send className="h-4 w-4" /> : <Check className="h-4 w-4" />}
                {made ? "Send approval to HR" : "Approve as expense"}
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() => void onReject().catch(() => undefined)}
              disabled={busy || !!made}
              title={made ? `Void ${made.expenseNumber} before rejecting` : undefined}
            >
              {reject.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}Reject
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}
