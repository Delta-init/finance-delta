"use client";

import { useRouter } from "next/navigation";
import type { CreateInvoiceInput } from "@delta/shared";
import { InvoiceForm } from "@/features/invoices/InvoiceForm";
import { useCreateInvoice } from "@/features/invoices/api";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";

export default function NewInvoicePage() {
  const router = useRouter();
  const create = useCreateInvoice();

  async function handleSubmit(input: CreateInvoiceInput) {
    try {
      const invoice = await create.mutateAsync(input);
      toast.success("Invoice created");
      router.push(`/invoices/${invoice.id}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to create invoice");
    }
  }

  return <InvoiceForm title="New Invoice" submitLabel="Create invoice" onSubmit={handleSubmit} />;
}
