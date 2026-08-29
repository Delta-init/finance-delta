"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  ArrowLeft, CheckCircle, XCircle, Ban, Send, RefreshCw, MapPin, User,
  Repeat, Pause, Play, CircleStop, Pencil,
} from "lucide-react";
import { formatMoney } from "@delta/shared";
import { EXPENSE_CATEGORY_LABELS, type ExpenseCategory } from "@delta/shared";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyDisplay } from "@/components/ui/money";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import {
  useExpense,
  useSubmitExpense,
  useApproveExpense,
  useRejectExpense,
  useVoidExpense,
  usePauseRecurrence,
  useResumeRecurrence,
  useStopRecurrence,
} from "@/features/expenses/api";
import { ExpenseReceipts } from "@/features/expenses/ExpenseReceipts";
import { useCan } from "@/lib/use-can";

const STATUS_TONE: Record<string, NonNullable<BadgeProps["tone"]>> = {
  draft: "neutral",
  submitted: "warning",
  approved: "success",
  rejected: "danger",
  voided: "neutral",
};

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  submitted: "Submitted",
  approved: "Approved",
  rejected: "Rejected",
  voided: "Voided",
};

const rejectFormSchema = z.object({
  reason: z.string().min(1, "Rejection reason is required"),
});
type RejectFormValues = z.infer<typeof rejectFormSchema>;

export default function ExpenseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: expense, isLoading } = useExpense(id);
  const submitExpense = useSubmitExpense(id);
  const { can } = useCan();
  const approveExpense = useApproveExpense(id);
  const rejectExpense = useRejectExpense(id);
  const voidExpense = useVoidExpense(id);
  const pauseRecurrence = usePauseRecurrence(id);
  const resumeRecurrence = useResumeRecurrence(id);
  const stopRecurrence = useStopRecurrence(id);
  const [rejectOpen, setRejectOpen] = useState(false);

  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } =
    useForm<RejectFormValues>({ resolver: zodResolver(rejectFormSchema) });

  async function handleAction(action: () => Promise<unknown>, msg: string) {
    try {
      await action();
      toast.success(msg);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Action failed");
    }
  }

  async function onRejectSubmit(values: RejectFormValues) {
    try {
      await rejectExpense.mutateAsync(values);
      toast.success("Expense rejected");
      setRejectOpen(false);
      reset();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to reject expense");
    }
  }

  if (isLoading) return <div className="flex h-64 items-center justify-center text-foreground-muted">Loading…</div>;
  if (!expense) return <div className="flex h-64 items-center justify-center text-foreground-muted">Expense not found.</div>;

  const canSubmit = expense.status === "draft" || expense.status === "rejected";
  // A claimant may edit until it goes to an approver; after that the amount
  // has been agreed against what was attached at the time. Somebody with the
  // broader permission is an approver and may still correct it. The server
  // enforces this either way — this is so the button is not offered to
  // somebody it would only refuse.
  const canEdit =
    expense.status !== "voided" &&
    (can("expense:update") || ["draft", "rejected"].includes(expense.status));

  // Submitted is when it *can* be approved; expense:approve is who may. Without
  // the permission these were still rendered, so a claimant saw Approve and
  // Reject on their own claim and got a refusal for pressing either.
  const canApproveReject = expense.status === "submitted" && can("expense:approve");
  const canVoid = expense.status !== "voided" && expense.status !== "approved";

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/expenses" className="rounded-md p-1.5 text-foreground-muted hover:bg-surface-muted">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold">{expense.expenseNumber}</h1>
            <Badge tone={STATUS_TONE[expense.status] ?? "neutral"}>
              {STATUS_LABELS[expense.status] ?? expense.status}
            </Badge>
            {expense.isRecurring && (
              <Badge tone="primary">
                <RefreshCw className="h-3 w-3 mr-1" /> Recurring
              </Badge>
            )}
          </div>
          <p className="text-sm text-foreground-muted">{expense.description}</p>
        </div>
        <div className="flex items-center gap-2">
          {canEdit && (
            <Link href={`/expenses/${id}/edit`}>
              <Button variant="outline" size="sm">
                <Pencil className="h-4 w-4" /> Edit
              </Button>
            </Link>
          )}
          {canSubmit && (
            <>
              {canVoid && (
                <Button variant="outline" size="sm" onClick={() => handleAction(() => voidExpense.mutateAsync(undefined), "Expense voided")} loading={voidExpense.isPending}>
                  <Ban className="h-4 w-4" /> Void
                </Button>
              )}
              <Button size="sm" onClick={() => handleAction(() => submitExpense.mutateAsync(undefined), "Expense submitted for approval")} loading={submitExpense.isPending}>
                <Send className="h-4 w-4" /> Submit
              </Button>
            </>
          )}
          {canApproveReject && (
            <>
              <Button variant="outline" size="sm" onClick={() => setRejectOpen(true)}>
                <XCircle className="h-4 w-4" /> Reject
              </Button>
              <Button size="sm" onClick={() => handleAction(() => approveExpense.mutateAsync(undefined), "Expense approved")} loading={approveExpense.isPending}>
                <CheckCircle className="h-4 w-4" /> Approve
              </Button>
            </>
          )}
          {expense.status === "approved" && (
            <Button variant="outline" size="sm" onClick={() => handleAction(() => voidExpense.mutateAsync(undefined), "Expense voided")} loading={voidExpense.isPending}>
              <Ban className="h-4 w-4" /> Void
            </Button>
          )}
        </div>
      </div>

      {/* Rejection notice */}
      {expense.status === "rejected" && expense.rejectedReason && (
        <div className="rounded-lg border border-danger/30 bg-danger/5 p-4">
          <p className="text-sm font-medium text-danger">Rejected{expense.approvedByName ? ` by ${expense.approvedByName}` : ""}</p>
          <p className="text-sm text-foreground-muted mt-1">{expense.rejectedReason}</p>
        </div>
      )}

      {/* Stat cards */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-border bg-surface p-4 space-y-1">
          <p className="text-xs text-foreground-muted">Amount (pre-tax)</p>
          <MoneyDisplay minor={expense.amountMinor} currency={expense.currency} className="font-semibold" />
        </div>
        <div className="rounded-lg border border-border bg-surface p-4 space-y-1">
          <p className="text-xs text-foreground-muted">Tax ({expense.taxPct}%)</p>
          <MoneyDisplay minor={expense.taxMinor} currency={expense.currency} className="font-medium text-foreground-muted" />
        </div>
        <div className="rounded-lg border border-border bg-surface p-4 space-y-1">
          <p className="text-xs text-foreground-muted">Total</p>
          <MoneyDisplay minor={expense.totalMinor} currency={expense.currency} className="font-semibold text-primary" />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Main column */}
        <div className="lg:col-span-2 space-y-4">
          {/* Recurring schedule */}
          {expense.isRecurring && expense.recurrence && (
            <div className="rounded-lg border border-border bg-surface p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold flex items-center gap-2">
                  <Repeat className="h-4 w-4 text-primary" /> Recurring schedule
                </h2>
                <Badge tone={expense.recurrence.isActive === false ? "warning" : "success"}>
                  {expense.recurrence.isActive === false ? "Paused" : "Active"}
                </Badge>
              </div>
              <div className="grid grid-cols-3 gap-3 text-sm">
                <div>
                  <p className="text-xs text-foreground-muted">Frequency</p>
                  <p className="font-medium capitalize">{expense.recurrence.frequency}</p>
                </div>
                <div>
                  <p className="text-xs text-foreground-muted">Next charge</p>
                  <p className="font-medium">{expense.recurrence.nextDate}</p>
                </div>
                <div>
                  <p className="text-xs text-foreground-muted">Ends</p>
                  <p className="font-medium">{expense.recurrence.endDate ?? "—"}</p>
                </div>
              </div>
              <p className="text-xs text-foreground-subtle">
                A new expense is generated automatically on each schedule date until you stop it
                {expense.recurrence.endDate ? " or the end date passes" : ""}.
              </p>
              <div className="flex flex-wrap gap-2 pt-1">
                {expense.recurrence.isActive === false ? (
                  <Button variant="outline" size="sm" onClick={() => handleAction(() => resumeRecurrence.mutateAsync(undefined), "Recurring schedule resumed")} loading={resumeRecurrence.isPending}>
                    <Play className="h-4 w-4" /> Resume
                  </Button>
                ) : (
                  <Button variant="outline" size="sm" onClick={() => handleAction(() => pauseRecurrence.mutateAsync(undefined), "Recurring schedule paused")} loading={pauseRecurrence.isPending}>
                    <Pause className="h-4 w-4" /> Pause
                  </Button>
                )}
                <Button variant="outline" size="sm" onClick={() => handleAction(() => stopRecurrence.mutateAsync(undefined), "Recurring schedule stopped")} loading={stopRecurrence.isPending}>
                  <CircleStop className="h-4 w-4" /> Stop
                </Button>
              </div>
            </div>
          )}

          {/* Mileage */}
          {expense.mileage && (
            <div className="rounded-lg border border-border bg-surface p-5 space-y-3">
              <div className="flex items-center gap-2">
                <MapPin className="h-4 w-4 text-foreground-muted" />
                <h2 className="text-sm font-semibold">Mileage</h2>
              </div>
              <div className="grid grid-cols-3 gap-4 text-sm">
                <div>
                  <p className="text-xs text-foreground-muted">Distance</p>
                  <p className="font-medium">{expense.mileage.distanceKm} km</p>
                </div>
                <div>
                  <p className="text-xs text-foreground-muted">Rate per km</p>
                  <p className="font-medium">{formatMoney(expense.mileage.ratePerKmMinor, expense.currency)}</p>
                </div>
                <div>
                  <p className="text-xs text-foreground-muted">Mileage Total</p>
                  <p className="font-semibold">{formatMoney(expense.mileage.totalMinor, expense.currency)}</p>
                </div>
              </div>
            </div>
          )}

          {/* Receipts. Editable only while the claim is still the
              claimant's — the server refuses once it is with an approver. */}
          <ExpenseReceipts
            expense={expense}
            editable={expense.status === "draft" || expense.status === "rejected"}
          />

          {/* Notes */}
          {expense.notes && (
            <div className="rounded-lg border border-border bg-surface p-5">
              <h2 className="text-sm font-semibold mb-2">Notes</h2>
              <p className="text-sm text-foreground-muted whitespace-pre-wrap">{expense.notes}</p>
            </div>
          )}
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-surface p-5 space-y-3">
            <h2 className="text-sm font-semibold">Details</h2>

            <div>
              <p className="text-xs text-foreground-muted">Category</p>
              <p className="text-sm font-medium mt-0.5">
                {expense.categoryName || expense.category}
              </p>
            </div>

            <div>
              <p className="text-xs text-foreground-muted">Expense Date</p>
              <p className="text-sm font-medium mt-0.5">{expense.expenseDate}</p>
            </div>

            {expense.paymentMethod && (
              <div>
                <p className="text-xs text-foreground-muted">Payment Method</p>
                <p className="text-sm font-medium mt-0.5 capitalize">{expense.paymentMethod.replace("_", " ")}</p>
              </div>
            )}

            {expense.paymentAccount && (
              <div>
                <p className="text-xs text-foreground-muted">Payment Account</p>
                <p className="text-sm font-medium mt-0.5">{expense.paymentAccount}</p>
              </div>
            )}

            {expense.reference && (
              <div>
                <p className="text-xs text-foreground-muted">Reference</p>
                <p className="text-sm font-medium mt-0.5">{expense.reference}</p>
              </div>
            )}

            {(expense.projectName || expense.costCentre) && (
              <div className="border-t border-border pt-3 space-y-2">
                {expense.projectName && (
                  <div>
                    <p className="text-xs text-foreground-muted">Project</p>
                    <p className="text-sm font-medium mt-0.5">{expense.projectName}</p>
                  </div>
                )}
                {expense.costCentre && (
                  <div>
                    <p className="text-xs text-foreground-muted">Cost Centre</p>
                    <p className="text-sm font-medium mt-0.5">{expense.costCentre}</p>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="rounded-lg border border-border bg-surface p-5 space-y-3">
            <h2 className="text-sm font-semibold">Submitted By</h2>
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-muted text-xs font-semibold text-foreground">
                {expense.submittedByName.slice(0, 2).toUpperCase()}
              </span>
              <div>
                <p className="text-sm font-medium">{expense.submittedByName}</p>
                <p className="text-xs text-foreground-muted">Submitted {expense.createdAt.slice(0, 10)}</p>
              </div>
            </div>
            {expense.approvedByName && (
              <div className="border-t border-border pt-3">
                <p className="text-xs text-foreground-muted mb-1">
                  {expense.status === "rejected" ? "Rejected by" : "Approved by"}
                </p>
                <div className="flex items-center gap-2">
                  <User className="h-4 w-4 text-foreground-muted shrink-0" />
                  <div>
                    <p className="text-sm font-medium">{expense.approvedByName}</p>
                    {expense.approvedAt && (
                      <p className="text-xs text-foreground-muted">{expense.approvedAt.slice(0, 10)}</p>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Reject Dialog */}
      <Dialog open={rejectOpen} onOpenChange={(o) => { if (!o) { setRejectOpen(false); reset(); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Reject Expense</DialogTitle></DialogHeader>
          <form onSubmit={handleSubmit(onRejectSubmit)} className="space-y-4">
            <div className="space-y-1.5">
              <Label>Reason for rejection *</Label>
              <textarea
                {...register("reason")}
                rows={3}
                placeholder="Explain why this expense is being rejected…"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-foreground-subtle focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 resize-none"
              />
              {errors.reason && <p className="text-xs text-danger">{errors.reason.message}</p>}
            </div>
            <DialogFooter>
              <DialogClose asChild><Button type="button" variant="ghost">Cancel</Button></DialogClose>
              <Button type="submit" variant="destructive" loading={isSubmitting}>Reject expense</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
