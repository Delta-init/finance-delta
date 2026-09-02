"use client";

import { useState } from "react";
import { GraduationCap, ShieldCheck, CheckCircle2, Undo2, Send, Clock } from "lucide-react";
import { formatMoney, paymentMethodLabel, type Invoice } from "@delta/shared";
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
import { useApproveInvoice, useReturnInvoice, useResubmitInvoice } from "@/features/invoices/api";

const MODE_LABELS: Record<string, string> = { online: "Online", offline: "Offline", hybrid: "Hybrid" };

/**
 * The decision an invoice is waiting on, and the enrolment behind it where
 * there is one.
 *
 * Shown to both sides but offering different things: an approver gets approve
 * and send back, whoever raised it gets the reason it came back and a way to
 * submit it again. Neither sees a control the other's permission would refuse.
 *
 * Absent entirely for an invoice that needs no approval, which is every invoice
 * raised by somebody trusted with the whole ledger.
 */
export function ApprovalPanel({ invoice }: { invoice: Invoice }) {
  const e = invoice.enrolment;
  const approval = invoice.approval;
  const { can } = useCan();
  const approve = useApproveInvoice(invoice.id);
  const sendBack = useReturnInvoice(invoice.id);
  const resubmit = useResubmitInvoice(invoice.id);
  const [returning, setReturning] = useState(false);
  const [reason, setReason] = useState("");

  if (!approval || approval.state === "not_required") return null;

  const canDecide = can("invoice:write");
  const pending = approval.state === "pending";
  const returned = approval.state === "returned";
  const approved = approval.state === "approved";

  const tone = approved ? "success" : returned ? "danger" : "warning";
  const label = approved ? "Approved" : returned ? "Sent back" : "Waiting for approval";

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
        {e ? (
          <GraduationCap className="h-4 w-4 text-foreground-muted" />
        ) : (
          <ShieldCheck className="h-4 w-4 text-foreground-muted" />
        )}
        <h2 className="text-sm font-semibold">{e ? "Enrolment" : "Approval"}</h2>
        <Badge tone={tone}>{label}</Badge>
        {approval.byName && (
          <span className="text-xs text-foreground-muted">
            {approved ? "by" : "sent back by"} {approval.byName}
          </span>
        )}
      </div>

      {e && (
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
                e.declaredPaymentMethod ? ` · ${paymentMethodLabel(e.declaredPaymentMethod)}` : ""
              }`}
            />
          ) : null}
        </div>
      )}

      {returned && approval.returnedReason && (
        <p className="rounded-lg border border-danger/30 bg-danger/5 p-2.5 text-sm">
          <span className="font-medium">Sent back:</span> {approval.returnedReason}
        </p>
      )}

      {pending && !canDecide && (
        <p className="flex items-center gap-1.5 text-sm text-foreground-muted">
          <Clock className="h-3.5 w-3.5" /> Nothing goes to the client until this is approved.
        </p>
      )}

      {/* What the approver still has to do once they have approved it, said
          here so it does not look finished when it is not. */}
      {approved && canDecide && invoice.status === "draft" && (
        <p className="flex items-center gap-1.5 text-sm text-foreground-muted">
          <Send className="h-3.5 w-3.5" /> Approved. Send the invoice and record the payment.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {canDecide && pending && (
          <>
            <Button size="sm" loading={approve.isPending}
              onClick={() => run("Invoice approved", () => approve.mutateAsync())}>
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
            <DialogTitle>Send this back</DialogTitle>
            <DialogDescription>
              {invoice.salespersonName} gets the reason and can correct it. Nothing reaches the client
              in the meantime.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="reason">What needs correcting?</Label>
            <Input id="reason" value={reason} maxLength={300}
              onChange={(ev) => setReason(ev.target.value)}
              placeholder="The amount does not match what was agreed" />
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
