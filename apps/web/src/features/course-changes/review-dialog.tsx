"use client";

import { useEffect, useState } from "react";
import type { CourseChange } from "@delta/shared";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MoneyDisplay } from "@/components/ui/money";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { formatWhen } from "@/features/tetra-deposits/status";
import { useDecideCourseChange } from "./api";

/**
 * A course change a salesperson asked for in their sales CRM (the user,
 * 2026-11-23): an approved enrolment moved to another course at another fee,
 * with why. Approving changes the invoice line to the new course at the new
 * fee — the balance follows — the enrolment's course, and opens any new LMS
 * course; rejecting needs a reason, which the CRM shows.
 */
export function CourseChangeReviewDialog({ change, onClose }: { change: CourseChange | null; onClose: () => void }) {
  const decide = useDecideCourseChange(change?.id ?? "");
  const [decision, setDecision] = useState<"approved" | "rejected">("approved");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  useEffect(() => {
    setDecision("approved"); setNote(""); setReason("");
  }, [change?.id]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!change) return;
    if (decision === "rejected" && reason.trim().length < 5) {
      toast.error("Add a short reason before rejecting");
      return;
    }
    try {
      await decide.mutateAsync(decision === "approved"
        ? { decision, ...(note.trim() ? { note: note.trim() } : {}) }
        : { decision, reason: reason.trim() });
      toast.success(decision === "approved" ? "Approved — the invoice and the enrolment are on the new course" : "Rejected — the sales CRM shows why");
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not record the decision");
    }
  };

  const c = change;
  const money = (minor: number, key: string) => <MoneyDisplay key={key} minor={minor} currency={c?.currency ?? "AED"} />;
  const rows: [string, React.ReactNode][] = c
    ? [
        ["Client", c.customerName],
        ["Invoice", c.invoiceNumber],
        ["From", <span key="f">{c.fromCourse || "—"} · {money(c.fromPriceMinor, "fp")}</span>],
        ["To", <span key="t">{c.course.name} · {money(c.priceMinor, "tp")}</span>],
        ...(c.invoice
          ? ([
              ["Paid so far", money(c.invoice.paidMinor, "p")],
              ["Left now", money(c.invoice.balanceMinor, "l")],
              ["Left after", money(c.invoice.balanceAfterMinor, "a")],
            ] as [string, React.ReactNode][])
          : []),
        ["Why", c.reason],
        ["Asked by", [c.requestedBy.name, c.requestedBy.email].filter(Boolean).join(" · ")],
        ["Asked on", formatWhen(c.receivedAt)],
      ]
    : [];

  return (
    <Dialog open={!!change} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Review course change</DialogTitle>
          <DialogDescription>
            From a sales CRM — an approved enrolment moved to another course at another fee, asked for by its salesperson. Approving it changes the invoice line to the new course at the new fee (the balance follows), the enrolment&rsquo;s course, and opens any new LMS course. Nothing is closed in the LMS.
          </DialogDescription>
        </DialogHeader>
        {c && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            {rows.filter(([, v]) => v !== "" && v !== undefined).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-foreground-muted">{k}</dt>
                <dd className="font-medium">{v}</dd>
              </div>
            ))}
          </dl>
        )}
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label>Decision</Label>
            <Select value={decision} onValueChange={(v) => setDecision(v as "approved" | "rejected")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="approved">Approve</SelectItem>
                <SelectItem value="rejected">Reject</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {decision === "approved" ? (
            <div className="space-y-1.5">
              <Label htmlFor="cc-note">Note (optional)</Label>
              <Textarea id="cc-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={2} />
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="cc-reason">Reason (required)</Label>
              <Textarea id="cc-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={3} placeholder="The salesperson sees this in their CRM" />
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" variant={decision === "rejected" ? "destructive" : "primary"} loading={decide.isPending}>
              {decision === "approved" ? "Approve change" : "Reject change"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
