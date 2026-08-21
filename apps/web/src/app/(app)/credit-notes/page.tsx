"use client";

import Link from "next/link";
import { formatMoney, type CreditNote } from "@delta/shared";
import { useCreditNotes } from "@/features/credit-notes/api";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ExportButton } from "@/components/ui/export-button";
import type { ExportColumn } from "@/lib/export";
import { FileX } from "lucide-react";

const STATUS_TONE: Record<string, BadgeProps["tone"]> = {
  draft: "neutral",
  issued: "primary",
  applied: "success",
  voided: "danger",
};

const CREDIT_NOTES_EXPORT_COLUMNS: ExportColumn<CreditNote>[] = [
  { header: "Number", value: (cn) => cn.creditNoteNumber },
  { header: "Customer", value: (cn) => cn.customerName },
  { header: "Invoice", value: (cn) => cn.invoiceNumber },
  { header: "Status", value: (cn) => cn.status },
  { header: "Created", value: (cn) => cn.createdAt.slice(0, 10) },
  { header: "Currency", value: (cn) => cn.currency },
  { header: "Total", value: (cn) => cn.totalMinor / 100 },
  { header: "Remaining", value: (cn) => (cn.totalMinor - cn.amountAppliedMinor) / 100 },
];

export default function CreditNotesPage() {
  const { data, isLoading } = useCreditNotes();

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Credit Notes</h1>
          <p className="text-sm text-foreground-muted">Issue credits against invoices</p>
        </div>
        <div className="flex items-center gap-2">
          <ExportButton
            resource="credit-notes"
            params={{}}
            columns={CREDIT_NOTES_EXPORT_COLUMNS}
            filename="credit-notes"
            title="Credit Notes"
            size="md"
          />
        </div>
      </div>

      {isLoading ? (
        <div className="flex h-48 items-center justify-center text-sm text-foreground-muted">
          Loading…
        </div>
      ) : !data?.length ? (
        <div className="flex h-48 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border">
          <FileX className="h-8 w-8 text-foreground-subtle" />
          <p className="text-sm text-foreground-muted">No credit notes yet</p>
          <p className="text-xs text-foreground-subtle">Issue a credit note from an invoice to get started</p>
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-foreground-muted">
                <th className="px-4 py-3 font-medium">Number</th>
                <th className="px-4 py-3 font-medium">Customer</th>
                <th className="px-4 py-3 font-medium">Invoice</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Created</th>
                <th className="px-4 py-3 text-right font-medium">Total</th>
                <th className="px-4 py-3 text-right font-medium">Remaining</th>
              </tr>
            </thead>
            <tbody>
              {data.map((cn) => (
                <tr key={cn.id} className="border-t border-border hover:bg-accent/30 transition-colors">
                  <td className="px-4 py-3">
                    <Link href={`/credit-notes/${cn.id}`} className="font-medium text-primary hover:underline">
                      {cn.creditNoteNumber}
                    </Link>
                  </td>
                  <td className="px-4 py-3">{cn.customerName}</td>
                  <td className="px-4 py-3">
                    <Link href={`/invoices/${cn.invoiceId}`} className="text-foreground-muted hover:text-foreground hover:underline">
                      {cn.invoiceNumber}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={STATUS_TONE[cn.status] ?? "neutral"} className="capitalize">
                      {cn.status}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-foreground-muted">{cn.createdAt.slice(0, 10)}</td>
                  <td className="px-4 py-3 text-right font-numeric">{formatMoney(cn.totalMinor, cn.currency)}</td>
                  <td className="px-4 py-3 text-right font-numeric">
                    {formatMoney(cn.totalMinor - cn.amountAppliedMinor, cn.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
