"use client";

import { useEffect, useState } from "react";
import type { FundingRequest } from "@delta/shared";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MoneyDisplay } from "@/components/ui/money";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useBudgetSummary, useReviewFundingRequest } from "@/features/budgets/api";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";

/**
 * Reviewing a fund request, wherever it is reviewed from.
 *
 * Budgets and Approvals both decide these, and they must decide them the same
 * way — above all, both must show what the department has left and refuse to
 * approve past it — so there is one dialog rather than two copies to drift.
 */

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export const periodLabel = (period: string) => {
  const [y, m] = period.split("-");
  return `${MONTHS[Number(m) - 1]} ${y}`;
};

const SOURCE_LABELS: Record<string, string> = { "media-erp": "Media ERP" };
export const sourceLabel = (source: string) => SOURCE_LABELS[source] ?? source;

const getError = (error: unknown, fallback: string) => error instanceof ApiError ? error.message : fallback;

export function FundingStatusPill({ status }: { status: FundingRequest["status"] }) {
  const styles = status === "approved" ? "bg-emerald-500/10 text-emerald-700" : status === "rejected" ? "bg-red-500/10 text-red-700" : "bg-amber-500/10 text-amber-700";
  return <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium capitalize ${styles}`}>{status}</span>;
}

/** Kind, where it came from, and the platform — the three things a reviewer scans for. */
export function FundingRequestTags({ request }: { request: FundingRequest }) {
  return <div className="mt-1 flex flex-wrap gap-1.5">
    {request.kind === "drawdown"
      ? <span className="rounded-full bg-sky-500/10 px-2 py-0.5 text-[11px] font-medium text-sky-700">Drawdown</span>
      : <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700">Top-up</span>}
    {request.source !== "finance" && <span className="rounded-full bg-violet-500/10 px-2 py-0.5 text-[11px] font-medium text-violet-700">{sourceLabel(request.source)}</span>}
    {request.platform && <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] text-foreground-muted">{request.platform}</span>}
  </div>;
}

export function FundingReviewDialog({ request, onClose }: { request: FundingRequest | null; onClose: () => void }) {
  const review = useReviewFundingRequest(request?.id ?? "");
  const [decision, setDecision] = useState<"approved" | "rejected">("approved");
  const [note, setNote] = useState("");
  useEffect(() => { if (request) { setDecision("approved"); setNote(""); } }, [request?.id]);
  // A drawdown spends the department's allocation, so show what is left of it
  // for that month — the same figure the server refuses an approval on.
  const drawdown = request?.kind === "drawdown";
  const { data: balanceResult, isLoading: balanceLoading } = useBudgetSummary(
    request ? { year: Number(request.period.slice(0, 4)), month: request.period, departmentId: request.departmentId } : {},
    !!request && drawdown,
  );
  const available = balanceResult?.data?.find((row) => row.currency === request?.currency)?.availableMinor ?? 0;
  const overBudget = !!request && drawdown && !balanceLoading && request.amountMinor > available;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!request) return;
    if (decision === "rejected" && note.trim().length < 5) { toast.error("Add a short reason before rejecting"); return; }
    try { await review.mutateAsync({ decision, note }); toast.success(decision === "approved" ? "Funding request approved" : "Funding request rejected"); onClose(); }
    catch (e) { toast.error(getError(e, "Could not review this request")); }
  };
  return <Dialog open={!!request} onOpenChange={(open) => !open && onClose()}><DialogContent>
    <DialogHeader><DialogTitle>Review funding request</DialogTitle><DialogDescription>{request ? `${request.departmentName} · ${periodLabel(request.period)} · ${request.title}` : ""}</DialogDescription></DialogHeader>
    {request && <div className="rounded-lg bg-surface-muted p-3 text-sm"><p className="font-medium">Requested by {request.requestedByName}{request.source !== "finance" && <span className="font-normal text-foreground-muted"> · {sourceLabel(request.source)}</span>}</p>{request.requestedByEmail && <p className="text-xs text-foreground-muted">{request.requestedByEmail}</p>}{request.platform && <p className="mt-1 text-xs text-foreground-muted">Platform: <span className="font-medium text-foreground">{request.platform}</span></p>}<p className="mt-2 whitespace-pre-wrap text-foreground-muted">{request.purpose}</p><p className="mt-3 font-semibold"><MoneyDisplay minor={request.amountMinor} currency={request.currency} />{drawdown && <span className="ml-2 text-xs font-normal text-foreground-muted">drawn from the {periodLabel(request.period)} allocation</span>}</p>
      {drawdown && <div className={`mt-3 rounded-md border px-3 py-2 text-xs ${overBudget ? "border-red-500/30 bg-red-500/5 text-red-700" : "border-border text-foreground-muted"}`}>{balanceLoading ? "Checking what is left…" : <>{request.departmentName} has <MoneyDisplay minor={available} currency={request.currency} /> left for {periodLabel(request.period)}.{overBudget ? " This request is more than that — raise the allocation first, or reject it." : <> After this request: <MoneyDisplay minor={available - request.amountMinor} currency={request.currency} />.</>}</>}</div>}
    </div>}
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-1.5"><Label>Decision</Label><Select value={decision} onValueChange={(v) => setDecision(v as "approved" | "rejected")}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="approved">Approve</SelectItem><SelectItem value="rejected">Reject</SelectItem></SelectContent></Select></div>
      <div className="space-y-1.5"><Label>{decision === "rejected" ? "Reason (required)" : "Review note (optional)"}</Label><Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={3} /></div>
      <DialogFooter><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" variant={decision === "rejected" ? "destructive" : "primary"} loading={review.isPending} disabled={decision === "approved" && (overBudget || (drawdown && balanceLoading))}>{decision === "approved" ? "Approve funds" : "Reject request"}</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>;
}
