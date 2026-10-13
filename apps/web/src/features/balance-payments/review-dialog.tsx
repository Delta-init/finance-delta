"use client";

import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { PAYMENT_METHOD_LABELS, type BalancePayment } from "@delta/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MoneyDisplay } from "@/components/ui/money";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useDecideBalancePayment } from "./api";

/**
 * A balance payment a salesperson recorded in their sales CRM (the user,
 * 2026-10-13): the payment, its receipt, and the invoice as it stands.
 * Approving records it on the invoice — paid on the day given, with the
 * receipt — which sets the next due date; rejecting needs a reason, which
 * the CRM shows.
 */
export function BalancePaymentReviewDialog({ payment, onClose }: { payment: BalancePayment | null; onClose: () => void }) {
  const decide = useDecideBalancePayment(payment?.id ?? "");
  const [decision, setDecision] = useState<"approved" | "rejected">("approved");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  useEffect(() => {
    setDecision("approved"); setReference(""); setNote(""); setReason("");
  }, [payment?.id]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!payment) return;
    if (decision === "rejected" && reason.trim().length < 5) {
      toast.error("Add a short reason before rejecting");
      return;
    }
    try {
      await decide.mutateAsync(decision === "approved"
        ? { decision, ...(reference.trim() ? { reference: reference.trim() } : {}), ...(note.trim() ? { note: note.trim() } : {}) }
        : { decision, reason: reason.trim() });
      toast.success(decision === "approved" ? "Approved — recorded on the invoice" : "Rejected — the sales CRM shows why");
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not record the decision");
    }
  };

  const p = payment;
  const rows: [string, React.ReactNode][] = p
    ? [
        ["Client", p.customerName],
        ["Invoice", p.invoiceNumber],
        ["Course", p.course],
        ["Paid", <MoneyDisplay key="a" minor={p.amountMinor} currency={p.currency} />],
        ["Method", PAYMENT_METHOD_LABELS[p.method as keyof typeof PAYMENT_METHOD_LABELS] ?? p.method],
        ["Paid on", p.paidOn],
        ["Recorded by", [p.recordedBy.name, p.recordedBy.email].filter(Boolean).join(" · ")],
        ["Note", p.note],
        ...(p.invoice
          ? ([
              ["Invoice total", <MoneyDisplay key="t" minor={p.invoice.totalMinor} currency={p.currency} />],
              ["Paid before", <MoneyDisplay key="b" minor={p.invoice.paidMinor} currency={p.currency} />],
              ["Left before this", <MoneyDisplay key="l" minor={p.invoice.balanceMinor} currency={p.currency} />],
            ] as [string, React.ReactNode][])
          : []),
      ]
    : [];

  return (
    <Dialog open={!!payment} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Review balance payment</DialogTitle>
          <DialogDescription>
            From a sales CRM — the next payment of a part-paid enrolment, recorded by its salesperson. Approving it records the payment on the invoice, which sets the next due date. Check it against the receipt first.
          </DialogDescription>
        </DialogHeader>
        {p && (
          <div className="space-y-3">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              {rows.filter(([, v]) => v !== "" && v !== undefined).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-foreground-muted">{k}</dt>
                  <dd className="font-medium">{v}</dd>
                </div>
              ))}
            </dl>
            {p.receipt.url && (
              <a href={p.receipt.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline">
                <ExternalLink className="h-3.5 w-3.5" /> Open the receipt ({p.receipt.name})
              </a>
            )}
          </div>
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
            <>
              <div className="space-y-1.5">
                <Label htmlFor="bp-ref">Reference (optional)</Label>
                <Input id="bp-ref" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} placeholder="As on the statement" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="bp-note">Note (optional)</Label>
                <Textarea id="bp-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={2} />
              </div>
            </>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="bp-reason">Reason (required)</Label>
              <Textarea id="bp-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={3} placeholder="The salesperson sees this in their CRM" />
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" variant={decision === "rejected" ? "destructive" : "primary"} loading={decide.isPending}>
              {decision === "approved" ? "Approve payment" : "Reject payment"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
