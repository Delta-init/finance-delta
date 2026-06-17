"use client";

import { use } from "react";
import Link from "next/link";
import { formatMoney } from "@delta/shared";
import { useCreditNote, useIssueCreditNote, useVoidCreditNote, useApplyCreditNote } from "@/features/credit-notes/api";
import { Badge } from "@/components/ui/badge";
import type { BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Printer, CheckCircle, XCircle, ArrowLeft, CreditCard } from "lucide-react";
import { toast } from "@/lib/toast";

const STATUS_TONE: Record<string, BadgeProps["tone"]> = {
  draft: "neutral",
  issued: "primary",
  applied: "success",
  voided: "danger",
};

export default function CreditNoteDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { data: cn, isLoading } = useCreditNote(id);
  const issue = useIssueCreditNote();
  const voidNote = useVoidCreditNote();
  const apply = useApplyCreditNote();

  if (isLoading) {
    return <div className="flex h-48 items-center justify-center text-sm text-foreground-muted">Loading…</div>;
  }
  if (!cn) {
    return <div className="flex h-48 items-center justify-center text-sm text-foreground-muted">Credit note not found.</div>;
  }

  const remaining = cn.totalMinor - cn.amountAppliedMinor;

  async function handleIssue() {
    try {
      await issue.mutateAsync(id);
      toast.success("Credit note issued");
    } catch {
      toast.error("Failed to issue credit note");
    }
  }

  async function handleApply() {
    try {
      await apply.mutateAsync({ id, input: { targetInvoiceId: cn!.invoiceId } });
      toast.success("Credit applied to invoice");
    } catch {
      toast.error("Failed to apply credit");
    }
  }

  async function handleVoid() {
    if (!confirm("Void this credit note? This cannot be undone.")) return;
    try {
      await voidNote.mutateAsync(id);
      toast.success("Credit note voided");
    } catch {
      toast.error("Failed to void credit note");
    }
  }

  return (
    <div className="space-y-6 p-6">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-foreground-muted">
        <Link href="/credit-notes" className="flex items-center gap-1 hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Credit Notes
        </Link>
        <span>/</span>
        <span className="font-medium text-foreground">{cn.creditNoteNumber}</span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold">{cn.creditNoteNumber}</h1>
            <Badge tone={STATUS_TONE[cn.status] ?? "neutral"} className="capitalize">
              {cn.status}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-foreground-muted">
            Customer: <span className="text-foreground font-medium">{cn.customerName}</span> · Invoice:{" "}
            <Link href={`/invoices/${cn.invoiceId}`} className="text-primary hover:underline">
              {cn.invoiceNumber}
            </Link>
          </p>
        </div>
        <div className="flex items-center gap-2">
          {cn.status === "draft" && (
            <Button size="sm" onClick={handleIssue} loading={issue.isPending}>
              <CheckCircle className="h-4 w-4" /> Issue
            </Button>
          )}
          {cn.status === "issued" && remaining > 0 && (
            <Button size="sm" onClick={handleApply} loading={apply.isPending}>
              <CreditCard className="h-4 w-4" /> Apply to Invoice
            </Button>
          )}
          {(cn.status === "draft" || cn.status === "issued") && (
            <Button size="sm" variant="destructive" onClick={handleVoid} loading={voidNote.isPending}>
              <XCircle className="h-4 w-4" /> Void
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={() => window.open(`/credit-notes/${id}/print`, "_blank")}>
            <Printer className="h-4 w-4" /> PDF
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Main content */}
        <div className="lg:col-span-2 space-y-4">
          {/* Reason */}
          <div className="rounded-xl border border-border bg-card p-5">
            <h2 className="mb-2 text-sm font-semibold text-foreground-muted uppercase tracking-wide">Reason</h2>
            <p className="text-sm">{cn.reason}</p>
          </div>

          {/* Line items */}
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-foreground-muted">
                  <th className="px-4 py-3 font-medium">Description</th>
                  <th className="px-4 py-3 text-right font-medium">Qty</th>
                  <th className="px-4 py-3 text-right font-medium">Unit Price</th>
                  <th className="px-4 py-3 text-right font-medium">Disc %</th>
                  <th className="px-4 py-3 text-right font-medium">Tax %</th>
                  <th className="px-4 py-3 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {cn.lineItems.map((line, i) => (
                  <tr key={i} className="border-t border-border">
                    <td className="px-4 py-3">{line.description}</td>
                    <td className="px-4 py-3 text-right">{line.quantity}</td>
                    <td className="px-4 py-3 text-right font-numeric">{formatMoney(line.unitPriceMinor, cn.currency)}</td>
                    <td className="px-4 py-3 text-right">{line.discountPct > 0 ? `${line.discountPct}%` : "—"}</td>
                    <td className="px-4 py-3 text-right">{line.taxPct > 0 ? `${line.taxPct}%` : "—"}</td>
                    <td className="px-4 py-3 text-right font-numeric font-medium">{formatMoney(line.lineTotalMinor, cn.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Side panel */}
        <div className="space-y-4">
          <div className="rounded-xl border border-border bg-card p-5 space-y-3">
            <h2 className="text-sm font-semibold text-foreground-muted uppercase tracking-wide">Summary</h2>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-foreground-muted">Subtotal</span>
                <span className="font-numeric">{formatMoney(cn.subtotalMinor, cn.currency)}</span>
              </div>
              {cn.taxTotalMinor > 0 && (
                <div className="flex justify-between">
                  <span className="text-foreground-muted">Tax</span>
                  <span className="font-numeric">{formatMoney(cn.taxTotalMinor, cn.currency)}</span>
                </div>
              )}
              <div className="flex justify-between border-t border-border pt-2 font-semibold">
                <span>Credit Total</span>
                <span className="font-numeric">{formatMoney(cn.totalMinor, cn.currency)}</span>
              </div>
              {cn.amountAppliedMinor > 0 && (
                <div className="flex justify-between text-foreground-muted">
                  <span>Applied</span>
                  <span className="font-numeric">− {formatMoney(cn.amountAppliedMinor, cn.currency)}</span>
                </div>
              )}
              <div className="flex justify-between border-t border-border pt-2 font-semibold text-primary">
                <span>Remaining</span>
                <span className="font-numeric">{formatMoney(remaining, cn.currency)}</span>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card p-5 space-y-2 text-sm">
            <h2 className="text-sm font-semibold text-foreground-muted uppercase tracking-wide">Details</h2>
            <div className="flex justify-between">
              <span className="text-foreground-muted">Created</span>
              <span>{cn.createdAt.slice(0, 10)}</span>
            </div>
            {cn.issuedAt && (
              <div className="flex justify-between">
                <span className="text-foreground-muted">Issued</span>
                <span>{cn.issuedAt.slice(0, 10)}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-foreground-muted">Currency</span>
              <span>{cn.currency}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
