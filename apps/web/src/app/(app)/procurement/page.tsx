"use client";

import { useState } from "react";
import Link from "next/link";
import { ClipboardList, Check, X, Loader2, Send, AlertTriangle } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
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
    <div>
      <PageHeader
        title="Procurement"
        description="Purchase requests HR has approved, waiting on the money decision. Approving one records it as an expense."
      />

      {isLoading ? (
        <div className="flex justify-center py-24"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : error ? (
        <div className="rounded-lg border border-border p-12 text-center text-muted-foreground">
          Could not reach HRMS. Check the integration settings and try again.
        </div>
      ) : !rows.length ? (
        <div className="rounded-lg border border-border p-16 text-center text-muted-foreground">
          <ClipboardList className="mx-auto mb-3 h-8 w-8 opacity-50" />
          Nothing is waiting for a decision.
        </div>
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

  return (
    <div className="rounded-lg border border-border p-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-semibold">{r.quantity} × {r.item}</h3>
          {r.resubmitCount > 0 && <Badge tone="warning">resubmitted ×{r.resubmitCount}</Badge>}
        </div>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {[
            `${r.currency} ${(r.estimatedCost || 0).toLocaleString("en-US")}${r.estimatedCost ? " estimated" : ", no estimate"}`,
            r.department?.name,
            r.requestedBy?.name ? `asked by ${r.requestedBy.name}` : null,
            r.neededBy ? `needed by ${String(r.neededBy).slice(0, 10)}` : null,
          ].filter(Boolean).join(" · ")}
        </p>
        {r.justification && <p className="mt-1 text-sm">{r.justification}</p>}
        {r.vendor && <p className="mt-1 text-xs text-muted-foreground">Suggested vendor: {r.vendor}</p>}
        {r.hrNote && <p className="mt-1 text-xs text-muted-foreground">HR: {r.hrNote}</p>}
      </div>

      {made && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-primary/30 bg-primary/5 p-3 text-sm">
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
        <div className="mt-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <span>
            {voided.expenseNumber} was recorded for this request and then voided. Reject it instead — HR can revise it
            and send it back.
          </span>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-end gap-3">
        {!made && !voided && (
          <>
            <div className="w-[150px]">
              <label className="mb-1 block text-xs text-muted-foreground">Amount ({r.currency}) *</label>
              <Input
                type="number" inputMode="decimal" min="0" step="0.01" value={amount} placeholder="0.00"
                aria-invalid={amount !== "" && !amountValid}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <div className="min-w-[180px]">
              <label className="mb-1 block text-xs text-muted-foreground">Category *</label>
              <Select value={chosenCategory} onValueChange={setCategory} disabled={categories.isLoading}>
                <SelectTrigger><SelectValue placeholder={categories.isLoading ? "Loading…" : "Choose a category"} /></SelectTrigger>
                <SelectContent>
                  {categoryList.map((c) => <SelectItem key={c.slug} value={c.slug}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {chosenCategory === "other" && (
              <div className="min-w-[160px]">
                <label className="mb-1 block text-xs text-muted-foreground">What it is</label>
                <Input value={categoryOther} maxLength={60} placeholder="e.g. Office equipment"
                  onChange={(e) => setCategoryOther(e.target.value)} />
              </div>
            )}
            <div className="min-w-[180px]">
              <label className="mb-1 block text-xs text-muted-foreground">Department</label>
              <Select value={chosenDepartment} onValueChange={setDepartment} disabled={departments.isLoading}>
                <SelectTrigger><SelectValue placeholder="No department" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_DEPARTMENT}>No department</SelectItem>
                  {departmentList.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </>
        )}
        <div className="min-w-[220px] flex-1">
          <label className="mb-1 block text-xs text-muted-foreground">Note</label>
          <Input value={note} maxLength={500} placeholder="Optional — sent back to HR"
            onChange={(e) => setNote(e.target.value)} />
        </div>
        <div className="flex gap-2">
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
      {!made && !voided && !amountValid && (
        <p className="mt-2 text-xs text-muted-foreground">
          {r.estimatedCost > 0 ? "Enter an amount above 0." : "HR gave no estimate — enter the amount being approved."}
        </p>
      )}
    </div>
  );
}
