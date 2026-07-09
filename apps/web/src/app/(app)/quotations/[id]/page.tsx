"use client";

import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useState } from "react";
import { ArrowLeft, Pencil, Send, Check, X, FileText, Trash2, Printer } from "lucide-react";
import { formatMoney } from "@delta/shared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import {
  useQuotation,
  useSendQuotation,
  useAcceptQuotation,
  useDeclineQuotation,
  useConvertQuotation,
  useConvertToInvoice,
  useDeleteQuotation,
} from "@/features/quotations/api";
import { QUOTE_STATUS_TONE } from "@/features/quotations/status";

export default function QuotationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data: q, isLoading } = useQuotation(id);
  const send = useSendQuotation();
  const accept = useAcceptQuotation();
  const decline = useDeclineQuotation();
  const convert = useConvertQuotation();
  const convertInv = useConvertToInvoice();
  const del = useDeleteQuotation();
  if (isLoading || !q) {
    return <div className="p-6 text-foreground-muted">Loading…</div>;
  }

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Action failed");
    }
  };

  const isDraft = q.status === "draft";
  const isOpen = q.status === "draft" || q.status === "sent" || q.status === "expired";
  const isAccepted = q.status === "accepted";
  const converted = !!q.convertedTo?.salesOrderId;
  const convertedToInvoice = !!q.convertedTo?.invoiceId;

  return (
    <div className="space-y-4 p-6">
      {/* Action bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          href="/quotations"
          className="inline-flex items-center gap-1.5 text-sm text-foreground-muted hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Quotations
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          {isDraft && (
            <Button variant="secondary" size="sm" onClick={() => router.push(`/quotations/${id}/edit`)}>
              <Pencil className="h-4 w-4" /> Edit
            </Button>
          )}
          {isOpen && (
            <Button variant="secondary" size="sm" loading={send.isPending} onClick={() => run(async () => { await send.mutateAsync(id); toast.success("Quotation sent"); })}>
              <Send className="h-4 w-4" /> Send
            </Button>
          )}
          {isOpen && (
            <>
              <Button variant="secondary" size="sm" loading={accept.isPending} onClick={() => run(async () => { await accept.mutateAsync(id); toast.success("Quotation accepted"); })}>
                <Check className="h-4 w-4" /> Accept
              </Button>
              <Button variant="ghost" size="sm" loading={decline.isPending} onClick={() => run(async () => { await decline.mutateAsync(id); toast.success("Quotation declined"); })}>
                <X className="h-4 w-4" /> Decline
              </Button>
            </>
          )}
          {isAccepted && !converted && (
            <Button
              size="sm"
              loading={convert.isPending}
              onClick={() =>
                run(async () => {
                  const r = await convert.mutateAsync({ id, input: { target: "salesOrder" } });
                  toast.success("Converted to sales order");
                  router.push(`/sales-orders?highlight=${r.salesOrder.id}`);
                })
              }
            >
              <FileText className="h-4 w-4" /> Convert to Sales Order
            </Button>
          )}
          {isAccepted && !convertedToInvoice && (
            <Button
              size="sm"
              variant="outline"
              loading={convertInv.isPending}
              onClick={() =>
                run(async () => {
                  const r = await convertInv.mutateAsync(id);
                  toast.success("Invoice created");
                  router.push(`/invoices/${r.invoice.id}`);
                })
              }
            >
              <FileText className="h-4 w-4" /> Convert to Invoice
            </Button>
          )}
          {convertedToInvoice && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => router.push(`/invoices/${q.convertedTo?.invoiceId}`)}
            >
              <FileText className="h-4 w-4" /> View Invoice
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => window.open(`/quotations/${id}/print`, "_blank")}
          >
            <Printer className="h-4 w-4" /> PDF
          </Button>
          {!converted && (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Delete quotation"
              loading={del.isPending}
              onClick={() =>
                run(async () => {
                  await del.mutateAsync(id);
                  toast.success("Quotation deleted");
                  router.push("/quotations");
                })
              }
            >
              <Trash2 className="h-4 w-4 text-danger" />
            </Button>
          )}
        </div>
      </div>

      {converted && (
        <p className="rounded-md bg-success/10 px-3 py-2 text-sm text-success">
          Converted to a sales order.
        </p>
      )}

      {/* Branded preview */}
      <div className="mx-auto w-full max-w-3xl rounded-xl border border-border bg-surface p-8 shadow-sm">
        <div className="flex items-start justify-between gap-4 border-b border-border pb-6">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground font-display text-base font-bold">
              Δ
            </span>
            <div>
              <p className="font-display text-lg font-semibold tracking-tight">Delta Finance</p>
              <p className="text-xs text-foreground-subtle">Quotation</p>
            </div>
          </div>
          <div className="text-right">
            <p className="font-numeric text-lg font-semibold">{q.quoteNumber}</p>
            <Badge tone={QUOTE_STATUS_TONE[q.status]} className="mt-1 capitalize">
              {q.status}
            </Badge>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 py-6 text-sm">
          <div>
            <p className="text-xs uppercase tracking-wide text-foreground-subtle">Bill to</p>
            <p className="mt-1 font-medium">{q.customerName}</p>
          </div>
          <div className="text-right">
            <p className="text-foreground-muted">
              Issued: <span className="text-foreground">{q.issueDate}</span>
            </p>
            <p className="text-foreground-muted">
              Expires: <span className="text-foreground">{q.expiryDate}</span>
            </p>
          </div>
        </div>

        <table className="w-full text-sm">
          <thead>
            <tr className="border-y border-border text-left text-xs uppercase tracking-wide text-foreground-subtle">
              <th className="py-2 font-medium">Description</th>
              <th className="w-16 py-2 text-right font-medium">Qty</th>
              <th className="w-28 py-2 text-right font-medium">Unit</th>
              <th className="w-16 py-2 text-right font-medium">Disc</th>
              <th className="w-16 py-2 text-right font-medium">Tax</th>
              <th className="w-28 py-2 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {q.lineItems.map((l, i) => (
              <tr key={i} className="border-b border-border">
                <td className="py-2.5">{l.description}</td>
                <td className="py-2.5 text-right font-numeric">{l.quantity}</td>
                <td className="py-2.5 text-right font-numeric">{formatMoney(l.unitPriceMinor, q.currency)}</td>
                <td className="py-2.5 text-right font-numeric">{l.discountPct}%</td>
                <td className="py-2.5 text-right font-numeric">{l.taxPct}%</td>
                <td className="py-2.5 text-right font-numeric">{formatMoney(l.lineTotalMinor, q.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mt-4 flex justify-end">
          <div className="w-64 space-y-1.5 text-sm">
            <div className="flex justify-between text-foreground-muted">
              <span>Subtotal</span>
              <span className="font-numeric text-foreground">{formatMoney(q.subtotalMinor, q.currency)}</span>
            </div>
            <div className="flex justify-between text-foreground-muted">
              <span>Discount</span>
              <span className="font-numeric text-foreground">{formatMoney(q.discountTotalMinor, q.currency)}</span>
            </div>
            {q.taxBreakdown?.length ? (
              q.taxBreakdown.map((t) => (
                <div key={t.code} className="flex justify-between text-foreground-muted">
                  <span>{t.code}</span>
                  <span className="font-numeric text-foreground">{formatMoney(t.amountMinor, q.currency)}</span>
                </div>
              ))
            ) : (
              <div className="flex justify-between text-foreground-muted">
                <span>Tax</span>
                <span className="font-numeric text-foreground">{formatMoney(q.taxTotalMinor, q.currency)}</span>
              </div>
            )}
            <div className="flex justify-between border-t border-border pt-1.5 text-base font-semibold">
              <span>Total</span>
              <span className="font-numeric">{formatMoney(q.totalMinor, q.currency)}</span>
            </div>
          </div>
        </div>

        {(q.notes || q.terms) && (
          <div className="mt-6 space-y-3 border-t border-border pt-4 text-sm">
            {q.notes && (
              <div>
                <p className="text-xs uppercase tracking-wide text-foreground-subtle">Notes</p>
                <p className="mt-1 text-foreground-muted">{q.notes}</p>
              </div>
            )}
            {q.terms && (
              <div>
                <p className="text-xs uppercase tracking-wide text-foreground-subtle">Terms</p>
                <p className="mt-1 text-foreground-muted">{q.terms}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
