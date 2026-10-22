"use client";

import { use } from "react";
import { useRouter } from "next/navigation";
import { approvalBlocksEditing, type UpdateInvoiceInput } from "@delta/shared";
import { InvoiceForm } from "@/features/invoices/InvoiceForm";
import { useInvoice, useResendInvoice, useUpdateInvoice } from "@/features/invoices/api";
import { useCan } from "@/lib/use-can";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";

export default function EditInvoicePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const { data: invoice, isLoading } = useInvoice(id);
  const update = useUpdateInvoice(id);
  const resend = useResendInvoice();
  const { can } = useCan();

  if (isLoading) return <div className="p-6 text-sm text-foreground-muted">Loading…</div>;
  if (!invoice) return <div className="p-6 text-sm text-foreground-muted">Invoice not found.</div>;
  // A sent invoice can be corrected (2026-10-22) — the invoice page offered Edit and the server allowed it, but
  // this screen still said drafts only. A voided one cannot: it is a cancelled record, restored first.
  if (invoice.status === "void") {
    return (
      <div className="p-6 text-sm text-foreground-muted">
        This invoice was voided. Restore it first, then make the correction.
      </div>
    );
  }
  // Reachable by typing the URL, and the server would refuse the save anyway —
  // said here so it is refused before the work rather than after it.
  if (!can("invoice:write") && approvalBlocksEditing(invoice.approval?.state)) {
    return (
      <div className="p-6 text-sm text-foreground-muted">
        {invoice.approval?.state === "approved"
          ? "This has been approved, so it can no longer be changed. Ask accounts to make the correction."
          : "This is with an approver and cannot be changed until it comes back."}
      </div>
    );
  }

  async function handleSubmit(input: UpdateInvoiceInput) {
    try {
      await update.mutateAsync(input);
      toast.success("Invoice saved");
      router.push(`/invoices/${id}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to save invoice");
    }
  }

  // Already with the client: saved, and the corrected invoice emailed to them again.
  async function handleSaveAndResend(input: UpdateInvoiceInput) {
    try {
      await update.mutateAsync(input);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to save invoice");
      return;
    }
    try {
      await resend.mutateAsync({ id });
      toast.success("Saved, and the corrected invoice sent to the client again");
    } catch (e) {
      toast.error(`Saved — but not resent: ${e instanceof ApiError ? e.message : "the email could not be sent"}`);
    }
    router.push(`/invoices/${id}`);
  }

  return (
    <InvoiceForm
      initial={invoice}
      title={`Edit ${invoice.invoiceNumber}`}
      submitLabel="Save changes"
      onSubmit={handleSubmit}
      alsoSubmit={invoice.status !== "draft" ? { label: "Save & resend to client", onSubmit: handleSaveAndResend } : undefined}
    />
  );
}
