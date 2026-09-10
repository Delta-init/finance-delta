"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatMoney } from "@delta/shared";
import { usePayment } from "@/features/payments/api";
import { useInvoice, useDeletePayment } from "@/features/invoices/api";
import { PaymentDialog } from "@/features/invoices/InvoiceDetail";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useCan } from "@/lib/use-can";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Printer, ExternalLink, Pencil, Trash2 } from "lucide-react";

export default function PaymentDetailPage({
  params,
}: {
  params: Promise<{ id: string; paymentId: string }>;
}) {
  const { id, paymentId } = use(params);
  const router = useRouter();
  const { data: payment, isLoading } = usePayment(paymentId);
  /*
   * The invoice as well as the payment.
   *
   * Correcting one needs the balance it is allowed to grow into, and the
   * payment in the shape the invoice keeps it — the same object the dialog on
   * the invoice page edits, so the two cannot disagree about what a payment is.
   */
  const { data: invoice } = useInvoice(id);
  const editable = invoice?.payments.find((p) => p.id === paymentId) ?? null;

  /*
   * The day it was paid, without the time nobody recorded.
   *
   * This endpoint returns the date as a full ISO instant, so the page read
   * "2026-09-10T00:00:00.000Z" where every other screen shows a date. The
   * midnight is an artefact of storing a day, not information.
   */
  const paidOn = String(payment?.paidOn ?? "").slice(0, 10);

  const { can } = useCan();
  const canEdit = can("invoice:write");
  const del = useDeletePayment(id);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  if (isLoading) {
    return <div className="flex h-48 items-center justify-center text-sm text-foreground-muted p-6">Loading…</div>;
  }
  if (!payment) {
    return <div className="flex h-48 items-center justify-center text-sm text-foreground-muted p-6">Payment not found.</div>;
  }

  return (
    <div className="space-y-6 p-6 max-w-2xl">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-foreground-muted">
        <Link href="/payments" className="flex items-center gap-1 hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Payments
        </Link>
        <span>/</span>
        <Link href={`/invoices/${id}`} className="hover:text-foreground">
          {payment.invoiceNumber}
        </Link>
        <span>/</span>
        <span className="font-medium text-foreground">Payment</span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold">{formatMoney(payment.amountMinor, payment.currency)}</h1>
          <p className="mt-1 text-sm text-foreground-muted">
            {paidOn} · <span className="capitalize">{payment.method.replace("_", " ")}</span>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => router.push(`/invoices/${id}/payments/${paymentId}/receipt`)}
          >
            <Printer className="h-4 w-4" /> Receipt PDF
          </Button>
          {/* Only for somebody who may change the invoice's money, which is
              what a payment is. The buttons wait for the invoice to arrive:
              editing needs the balance, and offering it before then would open
              a dialog that cannot say what the limit is. */}
          {canEdit && editable && (
            <>
              <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
                <Pencil className="h-4 w-4" /> Edit
              </Button>
              <Button size="sm" variant="destructive" onClick={() => setConfirming(true)}>
                <Trash2 className="h-4 w-4" /> Delete
              </Button>
            </>
          )}
          <Link href={`/invoices/${id}`}>
            <Button size="sm" variant="ghost">
              <ExternalLink className="h-4 w-4" /> Invoice
            </Button>
          </Link>
        </div>
      </div>

      {/* Details card */}
      <div className="rounded-xl border border-border bg-card p-6 space-y-4">
        <h2 className="text-sm font-semibold text-foreground-muted uppercase tracking-wide">Payment Details</h2>
        <div className="grid grid-cols-2 gap-x-8 gap-y-4 text-sm">
          <Field label="Invoice" value={payment.invoiceNumber} href={`/invoices/${id}`} />
          <Field label="Customer" value={payment.customerName} />
          <Field label="Date" value={paidOn} />
          <Field label="Method" value={payment.method.replace("_", " ")} capitalize />
          {payment.accountName && <Field label="Account" value={payment.accountName} />}
          {payment.reference && <Field label="Reference" value={payment.reference} />}
          <Field label="Currency" value={payment.currency} />
          <div className="col-span-2 pt-2 border-t border-border">
            <p className="text-xs text-foreground-muted mb-1">Amount</p>
            <p className="text-2xl font-semibold font-numeric text-success">
              {formatMoney(payment.amountMinor, payment.currency)}
            </p>
          </div>
          {payment.notes && (
            <div className="col-span-2">
              <p className="text-xs text-foreground-muted mb-1">Notes</p>
              <p className="whitespace-pre-wrap">{payment.notes}</p>
            </div>
          )}
        </div>
      </div>

      {/* The same dialog the invoice page uses, so there is one set of rules
          about what a payment may be. `balanceMinor` only seeds the amount for
          a new payment — on an edit the form fills from the payment itself —
          and the server is what actually refuses more than the invoice is
          worth. */}
      {editable && invoice && (
        <PaymentDialog
          open={editing}
          onClose={() => setEditing(false)}
          invoiceId={id}
          balanceMinor={invoice.balanceMinor}
          currency={invoice.currency}
          editing={editable}
        />
      )}

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete this payment?</DialogTitle>
            <DialogDescription>
              {formatMoney(payment.amountMinor, payment.currency)} recorded on {paidOn} comes
              off {payment.invoiceNumber}, and its balance goes back up by the same amount. This
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirming(false)}>Cancel</Button>
            <Button
              variant="destructive"
              loading={del.isPending}
              onClick={async () => {
                try {
                  await del.mutateAsync(paymentId);
                  toast.success("Payment deleted");
                  // Nothing left to show here, so leave rather than sit on a
                  // page describing a record that has gone.
                  router.push(`/invoices/${id}`);
                } catch (err) {
                  toast.error(err instanceof ApiError ? err.message : "Could not delete this payment");
                }
              }}
            >
              Delete payment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Field({
  label, value, href, capitalize,
}: {
  label: string; value: string; href?: string; capitalize?: boolean;
}) {
  return (
    <div>
      <p className="text-xs text-foreground-muted mb-0.5">{label}</p>
      {href ? (
        <Link href={href} className="text-primary hover:underline font-medium" style={{ textTransform: capitalize ? "capitalize" : undefined }}>
          {value}
        </Link>
      ) : (
        <p className="font-medium" style={{ textTransform: capitalize ? "capitalize" : undefined }}>{value}</p>
      )}
    </div>
  );
}
