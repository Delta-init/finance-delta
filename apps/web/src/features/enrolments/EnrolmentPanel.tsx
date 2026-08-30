"use client";

import { useState } from "react";
import { GraduationCap, CheckCircle2, Undo2, Send, Clock } from "lucide-react";
import { formatMoney, type Invoice } from "@delta/shared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useCan } from "@/lib/use-can";
import { useApproveEnrolment, useReturnEnrolment, useResubmitEnrolment } from "@/features/invoices/api";

const MODE_LABELS: Record<string, string> = { online: "Online", offline: "Offline", hybrid: "Hybrid" };
const METHOD_LABELS: Record<string, string> = {
  cash: "Cash", bank_transfer: "Bank transfer", cheque: "Cheque", card: "Card",
  easebuzz_emi: "Easebuzz EMI", tabby: "Tabby", other: "Other",
};

/**
 * The enrolment behind an invoice, and the decision it is waiting on.
 *
 * Shown to both sides but offering different things: an approver gets approve
 * and send back, the counsellor who raised it gets the reason it came back and
 * a way to submit it again. Neither sees a control the other's permission
 * would refuse.
 */
export function EnrolmentPanel({ invoice }: { invoice: Invoice }) {
  const e = invoice.enrolment;
  const { can } = useCan();
  const approve = useApproveEnrolment(invoice.id);
  const sendBack = useReturnEnrolment(invoice.id);
  const resubmit = useResubmitEnrolment(invoice.id);
  const [returning, setReturning] = useState(false);
  const [reason, setReason] = useState("");

  if (!e) return null;

  const canDecide = can("invoice:write");
  const pending = e.approval === "pending";
  const returned = e.approval === "returned";

  const tone = e.approval === "approved" ? "success" : returned ? "danger" : "warning";
  const label = e.approval === "approved" ? "Approved" : returned ? "Sent back" : "Waiting for approval";

  async function run(what: string, fn: () => Promise<unknown>) {
    try {
      await fn();
      toast.success(what);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "That didn't work");
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface p-5">
      <div className="flex flex-wrap items-center gap-2">
        <GraduationCap className="h-4 w-4 text-foreground-muted" />
        <h2 className="text-sm font-semibold">Enrolment</h2>
        <Badge tone={tone}>{label}</Badge>
        {e.approvedByName && (
          <span className="text-xs text-foreground-muted">
            {e.approval === "approved" ? "by" : "sent back by"} {e.approvedByName}
          </span>
        )}
      </div>

      <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
        <Detail label="Course" value={e.course} />
        <Detail label="Mode of study" value={MODE_LABELS[e.modeOfStudy] ?? e.modeOfStudy} />
        <Detail label="Language" value={e.language} />
        <Detail label="Academic counsellor" value={invoice.salespersonName} />
        {e.meetingBy ? <Detail label="Meeting done by" value={e.meetingBy} /> : null}
        {e.declaredPaidMinor ? (
          <Detail
            label="Collected by counsellor"
            value={`${formatMoney(e.declaredPaidMinor, invoice.currency)}${
              e.declaredPaymentMethod ? ` · ${METHOD_LABELS[e.declaredPaymentMethod] ?? e.declaredPaymentMethod}` : ""
            }`}
          />
        ) : null}
      </div>

      {returned && e.returnedReason && (
        <p className="rounded-lg border border-danger/30 bg-danger/5 p-2.5 text-sm">
          <span className="font-medium">Sent back:</span> {e.returnedReason}
        </p>
      )}

      {pending && !canDecide && (
        <p className="flex items-center gap-1.5 text-sm text-foreground-muted">
          <Clock className="h-3.5 w-3.5" /> Nothing goes to the client until this is approved.
        </p>
      )}

      {/* What the approver still has to do once they have approved it, said
          here so it does not look finished when it is not. */}
      {e.approval === "approved" && canDecide && invoice.status === "draft" && (
        <p className="flex items-center gap-1.5 text-sm text-foreground-muted">
          <Send className="h-3.5 w-3.5" /> Approved. Send the invoice and record the payment.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {canDecide && pending && (
          <>
            <Button size="sm" loading={approve.isPending}
              onClick={() => run("Enrolment approved", () => approve.mutateAsync())}>
              <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />Approve
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setReturning(true)}>
              <Undo2 className="mr-1.5 h-3.5 w-3.5" />Send back
            </Button>
          </>
        )}
        {!canDecide && returned && (
          <Button size="sm" loading={resubmit.isPending}
            onClick={() => run("Sent for approval again", () => resubmit.mutateAsync())}>
            Submit again
          </Button>
        )}
      </div>

      <Dialog open={returning} onOpenChange={(o) => { if (!o) setReason(""); setReturning(o); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Send this enrolment back</DialogTitle>
            <DialogDescription>
              {invoice.salespersonName} gets the reason and can correct it. Nothing reaches the client
              in the meantime.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="reason">What needs correcting?</Label>
            <Input id="reason" value={reason} maxLength={300}
              onChange={(ev) => setReason(ev.target.value)}
              placeholder="The course amount does not match what was agreed" />
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setReturning(false)}>Cancel</Button>
            <Button
              loading={sendBack.isPending}
              disabled={reason.trim().length === 0}
              onClick={async () => {
                await run("Sent back", () => sendBack.mutateAsync(reason.trim()));
                setReturning(false);
                setReason("");
              }}
            >
              Send back
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-foreground-muted">{label}</p>
      <p className="text-sm font-medium">{value}</p>
    </div>
  );
}
