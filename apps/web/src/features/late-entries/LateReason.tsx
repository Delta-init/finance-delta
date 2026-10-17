"use client";

import { Clock } from "lucide-react";
import { isLateDate, type RecordLateEntry } from "@delta/shared";
import { Badge } from "@/components/ui/badge";
import { useLateEntriesMe } from "./api";

/**
 * The organization's late-entry days, and whether a date is past them (2026-10-17). On an edit, only a date that
 * changed asks — a record already dated back is not asked again for its other fields.
 */
export function useLateDate(date: string | undefined, initialDate?: string) {
  const { data: me } = useLateEntriesMe();
  const days = me?.days ?? 0;
  const changed = !initialDate || (date ?? "").slice(0, 10) !== initialDate.slice(0, 10);
  return { days, late: changed && isLateDate(date ?? "", days) };
}

/**
 * Shown under a date field when the date is more than the organization's days back: a manager has to approve it, and
 * the reason it is entered late is asked for.
 */
export function LateReasonField({
  late, days, value, onChange, what = "entry",
}: { late: boolean; days: number; value: string; onChange: (v: string) => void; what?: string }) {
  if (!late) return null;
  return (
    <div className="space-y-1.5 rounded-md border border-warning/40 bg-warning/5 p-3">
      <p className="flex items-center gap-1.5 text-xs font-medium text-warning">
        <Clock className="h-3.5 w-3.5" />
        Dated more than {days} day{days === 1 ? "" : "s"} back — a manager must approve this {what}.
      </p>
      <label className="block text-xs font-medium text-foreground-muted" htmlFor="late-reason">
        Reason it is entered late *
      </label>
      <textarea
        id="late-reason"
        value={value}
        maxLength={500}
        rows={2}
        onChange={(e) => onChange(e.target.value)}
        placeholder="e.g. receipt only reached accounts today"
        className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm placeholder:text-foreground-subtle focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
      />
    </div>
  );
}

/** What a record says of its late entry: waiting for a manager, approved, or rejected and why. */
export function LateBadge({ late, full = false }: { late?: RecordLateEntry; full?: boolean }) {
  if (!late || late.state === "withdrawn") return null;
  const tone = late.state === "pending" ? "warning" : late.state === "approved" ? "success" : "danger";
  const label = late.state === "pending" ? "Late entry — waiting for a manager"
    : late.state === "approved" ? `Late entry approved${late.decidedByName ? ` by ${late.decidedByName}` : ""}`
    : `Late entry rejected${late.decidedByName ? ` by ${late.decidedByName}` : ""}`;
  if (!full) return <Badge tone={tone} title={late.reason}>{late.state === "pending" ? "Late — waiting" : late.state === "approved" ? "Late — approved" : "Late — rejected"}</Badge>;
  return (
    <div className="space-y-0.5">
      <Badge tone={tone}>{label}</Badge>
      <p className="text-xs text-foreground-muted">Why late ({late.enteredByName}): {late.reason}</p>
      {late.decisionNote && <p className="text-xs text-foreground-muted">{late.state === "rejected" ? "Rejected because" : "Note"}: {late.decisionNote}</p>}
    </div>
  );
}
