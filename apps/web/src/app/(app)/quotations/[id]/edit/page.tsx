"use client";

import { useParams, useRouter } from "next/navigation";
import { QuotationForm } from "@/features/quotations/QuotationForm";
import { useQuotation, useUpdateQuotation } from "@/features/quotations/api";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";

export default function EditQuotationPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data, isLoading } = useQuotation(id);
  const update = useUpdateQuotation(id);

  if (isLoading || !data) {
    return <div className="p-6 text-foreground-muted">Loading…</div>;
  }

  return (
    <QuotationForm
      initial={data}
      title={`Edit ${data.quoteNumber}`}
      submitLabel="Save changes"
      onSubmit={async (input) => {
        try {
          await update.mutateAsync(input);
          toast.success("Quotation saved");
          router.push(`/quotations/${id}`);
        } catch (e) {
          toast.error(e instanceof ApiError ? e.message : "Failed to save quotation");
        }
      }}
    />
  );
}
