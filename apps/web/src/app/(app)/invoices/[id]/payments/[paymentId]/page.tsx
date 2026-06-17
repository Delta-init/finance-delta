"use client";

import { use } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatMoney } from "@delta/shared";
import { usePayment } from "@/features/payments/api";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Printer, ExternalLink } from "lucide-react";

export default function PaymentDetailPage({
  params,
}: {
  params: Promise<{ id: string; paymentId: string }>;
}) {
  const { id, paymentId } = use(params);
  const router = useRouter();
  const { data: payment, isLoading } = usePayment(paymentId);

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
            {payment.paidOn} · <span className="capitalize">{payment.method.replace("_", " ")}</span>
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => router.push(`/invoices/${id}/payments/${paymentId}/receipt`)}
          >
            <Printer className="h-4 w-4" /> Receipt PDF
          </Button>
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
          <Field label="Date" value={payment.paidOn} />
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
