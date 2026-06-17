"use client";

import { use } from "react";
import { useRouter } from "next/navigation";
import type { UpdateInvoiceInput } from "@delta/shared";
import { InvoiceForm } from "@/features/invoices/InvoiceForm";
import { useInvoice, useUpdateInvoice } from "@/features/invoices/api";
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

  if (isLoading) return <div className="p-6 text-sm text-foreground-muted">Loading…</div>;
  if (!invoice) return <div className="p-6 text-sm text-foreground-muted">Invoice not found.</div>;
  if (invoice.status !== "draft") {
    return (
      <div className="p-6 text-sm text-foreground-muted">
        Only draft invoices can be edited.
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

  return (
    <InvoiceForm
      initial={invoice}
      title={`Edit ${invoice.invoiceNumber}`}
      submitLabel="Save changes"
      onSubmit={handleSubmit}
    />
  );
}
