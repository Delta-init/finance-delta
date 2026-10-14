"use client";

import { useState } from "react";
import { UserPlus, Check, X, Loader2, Send, AlertTriangle, FileText } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { MoneyDisplay } from "@/components/ui/money";
import { toast } from "@/lib/toast";
import { useHiringRequests, useApproveHiring, useRejectHiring, type HiringRequest } from "@/features/hiring/api";

/**
 * Hiring requests waiting on finance (2026-10-15).
 *
 * HRMS sends finance a request to fill a role once HR has approved it, when its
 * cost is not already in the budget: new headcount, or a replacement paid more
 * than the person leaving. Approving lets recruiting start; rejecting needs a
 * reason, which the person who asked is told. Nothing is booked here — a role
 * costs nothing until somebody is hired.
 */
export default function HiringPage() {
  const { data, isLoading, error } = useHiringRequests();
  const rows = data ?? [];

  return (
    <div className="space-y-4 p-4 md:p-6">
      <PageHeader
        icon={UserPlus}
        title="Hiring requests"
        description="Roles HR has approved whose cost is not in the budget yet — new headcount, or a replacement paid more than the person leaving. Approve to let recruiting start, or reject with a reason."
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
          <UserPlus className="mx-auto mb-3 h-8 w-8 opacity-40" />
          Nothing is waiting for a decision.
        </Card>
      ) : (
        <div className="space-y-4">
          {rows.map((r) => <HiringCard key={`${r.hrmsOrgId}:${r._id}`} req={r} />)}
        </div>
      )}
    </div>
  );
}

const EMPLOYMENT: Record<string, string> = { full_time: "Full time", part_time: "Part time", contract: "Contract", intern: "Intern" };
const day = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Dubai" }) : "");

function HiringCard({ req: r }: { req: HiringRequest }) {
  const approve = useApproveHiring();
  const reject = useRejectHiring();
  const [note, setNote] = useState("");
  const busy = approve.isPending || reject.isPending;
  const id = (field: string) => `hiring-${r._id}-${field}`;
  const undelivered = r.undelivered;

  const onApprove = async () => {
    await approve.mutateAsync({ id: r._id, hrmsOrgId: r.hrmsOrgId, note: note.trim() });
    toast.success("Approved — HRMS has been told, and recruiting can start");
  };
  const onReject = async () => {
    // A resend sends the reason already kept with the decision; the server uses that one.
    if (undelivered?.decision === "rejected") {
      await reject.mutateAsync({ id: r._id, hrmsOrgId: r.hrmsOrgId, note: note.trim() || "(resend)" });
      toast.success("Sent — the person who asked has been told");
      return;
    }
    if (note.trim().length < 3) {
      toast.error("Say why it is rejected — the person who asked is told");
      return;
    }
    await reject.mutateAsync({ id: r._id, hrmsOrgId: r.hrmsOrgId, note: note.trim() });
    toast.success("Rejected — the person who asked has been told");
  };

  const facts = [
    r.department?.name,
    r.designation && r.designation !== r.title ? r.designation : null,
    r.employmentType ? EMPLOYMENT[r.employmentType] ?? r.employmentType : null,
    r.location ? r.location[0]!.toUpperCase() + r.location.slice(1) : null,
    r.targetStartDate ? `Start by ${day(r.targetStartDate)}` : null,
    r.hrmsOrgName,
  ].filter(Boolean);
  const salary = r.salaryMin || r.salaryMax;

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold">{r.headcount > 1 ? `${r.headcount} × ` : ""}{r.title}</h3>
            <Badge tone={r.type === "new_headcount" ? "primary" : "neutral"}>{r.type === "new_headcount" ? "New headcount" : "Replacement"}</Badge>
          </div>
          {facts.length > 0 && <p className="text-sm text-foreground-muted">{facts.join(" · ")}</p>}
          {r.justification && <p className="text-sm">{r.justification}</p>}
          <div className="flex flex-wrap gap-x-5 gap-y-1 pt-1 text-xs text-foreground-muted">
            {r.raisedBy?.name && <span>Asked by <span className="text-foreground">{r.raisedBy.name}</span></span>}
            {(r.hrApprovedBy || r.hrApprovedAt) && (
              <span>Approved by HR{r.hrApprovedBy ? <> — <span className="text-foreground">{r.hrApprovedBy}</span></> : null}{r.hrApprovedAt ? `, ${day(r.hrApprovedAt)}` : ""}</span>
            )}
            {r.replacing && (
              <span>
                Replacing <span className="text-foreground">{r.replacing.name}</span>
                {r.replacing.salary ? <> (paid <MoneyDisplay minor={Math.round(r.replacing.salary * 100)} currency={r.currency} />)</> : null}
              </span>
            )}
            {r.jdUrl && (
              <a href={r.jdUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline">
                <FileText className="h-3 w-3" />{r.jdFileName || "Job description"}
              </a>
            )}
          </div>
          {r.jdText && (
            <details className="pt-1 text-sm">
              <summary className="cursor-pointer text-xs font-medium text-foreground-muted">Job description</summary>
              <p className="mt-1 whitespace-pre-wrap text-foreground-muted">{r.jdText}</p>
            </details>
          )}
        </div>
        <div className="shrink-0 sm:text-right">
          <p className="text-xs font-medium uppercase tracking-wide text-foreground-muted">Salary{r.headcount > 1 ? " each" : ""}</p>
          {salary ? (
            <p className="text-lg font-semibold">
              {r.salaryMin ? <MoneyDisplay minor={Math.round(r.salaryMin * 100)} currency={r.currency} /> : null}
              {r.salaryMin && r.salaryMax ? " – " : ""}
              {r.salaryMax ? <MoneyDisplay minor={Math.round(r.salaryMax * 100)} currency={r.currency} /> : null}
            </p>
          ) : <p className="text-sm text-foreground-muted">Not given</p>}
          <p className="text-xs text-foreground-muted">a month</p>
        </div>
      </div>

      {undelivered && (
        <div className="mx-5 mb-5 flex items-start gap-2 rounded-md border border-primary/40 bg-primary/5 p-3 text-sm">
          <Send className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <span>
            {undelivered.decidedByName || "Someone"} {undelivered.decision} this here on {day(undelivered.decidedAt)}, but HRMS has not been told yet.
            {" "}{undelivered.decision === "approved" ? "Approve" : "Reject"} it again to send it.
          </span>
        </div>
      )}

      <div className="flex flex-col gap-4 border-t border-border bg-surface-muted/50 p-5 lg:flex-row lg:items-end">
        <div className="min-w-0 flex-1 space-y-1.5">
          <Label htmlFor={id("note")}>Note {undelivered ? "" : "(needed to reject)"}</Label>
          <Input id={id("note")} value={note} maxLength={500} placeholder="Sent to the person who asked, with the decision"
            onChange={(e) => setNote(e.target.value)} />
        </div>
        <div className="flex shrink-0 gap-2">
          {undelivered?.decision !== "rejected" && (
            <Button onClick={() => void onApprove().catch(() => undefined)} disabled={busy}>
              {approve.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : undelivered ? <Send className="h-4 w-4" /> : <Check className="h-4 w-4" />}
              {undelivered ? "Send to HRMS" : "Approve"}
            </Button>
          )}
          {undelivered?.decision !== "approved" && (
            <Button variant="outline" onClick={() => void onReject().catch(() => undefined)} disabled={busy}>
              {reject.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}{undelivered ? "Send to HRMS" : "Reject"}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
