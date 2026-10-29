"use client";

import { useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { describeOverdue, type TetraDeposit } from "@delta/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { MoneyDisplay } from "@/components/ui/money";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useReopenTetraDeposit, useTetraDeposits } from "./api";
import { TetraDepositReviewDialog, TetraTypeTag, isBonus, mt5BonusOf, paidBy, typedApproved, typedPaid } from "./review-dialog";

/**
 * CS Portal's deposits on the Approvals page: the ones waiting for a
 * decision, decided right here, and — underneath, only when there are any —
 * decisions CS Portal does not have yet: still on their way, or turned
 * down and waiting to be reopened.
 */

const ago = (iso?: string) =>
  iso
    ? describeOverdue(iso.slice(0, 10)).replace("days late", "days ago").replace("1 day late", "yesterday").replace("due today", "today")
    : "";

function Waiting({ deposit, onReview, onSendBack }: { deposit: TetraDeposit; onReview: () => void; onSendBack: () => void }) {
  return (
    <li className="flex flex-col gap-3 px-5 py-3 sm:flex-row sm:items-start">
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{deposit.student.name}{deposit.student.code ? <span className="font-normal text-foreground-muted"> · {deposit.student.code}</span> : null}</p>
        <div className="mt-1 flex flex-wrap gap-1.5">
          <span className="rounded-full bg-violet-500/10 px-2 py-0.5 text-[11px] font-medium text-violet-700">CS Portal</span>
          <TetraTypeTag deposit={deposit} />
          {paidBy(deposit) && <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] text-foreground-muted">{paidBy(deposit)}</span>}
          {deposit.team && <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] text-foreground-muted">{deposit.team}</span>}
          {deposit.resubmit && (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-800" title={deposit.resubmit.reason ? `It was sent back: ${deposit.resubmit.reason}` : undefined}>
              Sent again, corrected
            </span>
          )}
        </div>
        <p className="mt-1 text-xs text-foreground-muted">
          {[deposit.requestedBy || deposit.initiatingMentor, deposit.mt5Login && `MT5 ${deposit.mt5Login}`, ago(deposit.requestedAt)].filter(Boolean).join(" · ")}
        </p>
      </div>
      <div className="flex shrink-0 items-center justify-between gap-3 sm:flex-col sm:items-end">
        <div className="text-right">
          <MoneyDisplay minor={typedPaid(deposit).minor} currency={typedPaid(deposit).currency} className="font-semibold" />
          {/* The payment, not the bonus: that is credited in CS Portal (2026-10-15). */}
          {isBonus(deposit) && <p className="text-[11px] text-foreground-muted">paid{mt5BonusOf(deposit) !== null ? ` · MT5 bonus $${mt5BonusOf(deposit)!.toLocaleString("en-US")}` : ""}</p>}
        </div>
        <div className="flex gap-2">
          {/* Like an invoice's: back to the CS with what to correct (2026-10-13) — bonuses, which they can send again. */}
          {isBonus(deposit) && <Button size="sm" variant="ghost" onClick={onSendBack}>Send back</Button>}
          <Button size="sm" variant="outline" onClick={onReview}>Review</Button>
        </div>
      </div>
    </li>
  );
}

function NotDelivered({ deposit }: { deposit: TetraDeposit }) {
  const reopen = useReopenTetraDeposit();
  const failed = deposit.delivery?.state === "failed";
  const amount = typedApproved(deposit, deposit.decision?.approvedAmountMinor);
  const doReopen = async () => {
    try {
      await reopen.mutateAsync(deposit.id);
      toast.success("Reopened — it is back in the queue to decide again");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not reopen it");
    }
  };
  return (
    <li className="flex flex-col gap-2 px-5 py-2.5 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {deposit.student.name} · <span className="capitalize">{deposit.status}</span>
          {deposit.decision?.decidedByName ? <span className="font-normal text-foreground-muted"> by {deposit.decision.decidedByName}</span> : null}
        </p>
        <p className="truncate text-xs text-foreground-muted">
          {failed
            ? `CS Portal did not accept it: ${deposit.delivery?.lastError ?? "no reason given"}`
            : `On its way to CS Portal${deposit.delivery?.lastError ? ` — not reached yet (${deposit.delivery.lastError}); trying again on its own` : ""}`}
        </p>
      </div>
      <MoneyDisplay minor={amount.minor} currency={amount.currency} className="shrink-0 text-sm" />
      {failed && (
        <Button size="sm" variant="outline" onClick={doReopen} loading={reopen.isPending}>
          <RefreshCw className="h-3.5 w-3.5" /> Reopen
        </Button>
      )}
    </li>
  );
}

export function TetraDepositQueue() {
  const [reviewTarget, setReviewTarget] = useState<TetraDeposit | null>(null);
  const [reviewStart, setReviewStart] = useState<"approved" | "sentBack">("approved");
  const waiting = useTetraDeposits("waiting");
  const attention = useTetraDeposits("attention");
  const rows = waiting.data?.data ?? [];
  const stuck = attention.data?.data ?? [];

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">CS Portal deposits</h2>
        {rows.length > 0 && <Badge tone="warning">{rows.length}</Badge>}
      </div>
      <Card className="overflow-hidden">
        {waiting.isLoading ? (
          <p className="px-5 py-6 text-sm text-foreground-muted">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="px-5 py-6 text-sm text-foreground-muted">No deposits waiting.</p>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((d) => (
              <Waiting
                key={d.id} deposit={d}
                onReview={() => { setReviewStart("approved"); setReviewTarget(d); }}
                onSendBack={() => { setReviewStart("sentBack"); setReviewTarget(d); }}
              />
            ))}
          </ul>
        )}
      </Card>
      {stuck.length > 0 && (
        <div className="rounded-lg border border-warning/30 bg-warning/5">
          <div className="flex items-center gap-2 border-b border-warning/20 px-5 py-3">
            <AlertTriangle className="h-4 w-4 text-warning" />
            <h3 className="text-sm font-semibold">
              {stuck.length === 1 ? "1 decision CS Portal does not have yet" : `${stuck.length} decisions CS Portal does not have yet`}
            </h3>
          </div>
          <ul className="divide-y divide-warning/20">
            {stuck.map((d) => <NotDelivered key={d.id} deposit={d} />)}
          </ul>
        </div>
      )}
      <TetraDepositReviewDialog deposit={reviewTarget} start={reviewStart} onClose={() => setReviewTarget(null)} />
    </div>
  );
}
