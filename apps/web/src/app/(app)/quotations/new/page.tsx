"use client";

import { useRouter } from "next/navigation";
import { QuotationForm } from "@/features/quotations/QuotationForm";
import { useCreateQuotation } from "@/features/quotations/api";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";

export default function NewQuotationPage() {
  const router = useRouter();
  const create = useCreateQuotation();
  return (
    <QuotationForm
      title="New Quotation"
      submitLabel="Create quotation"
      onSubmit={async (input) => {
        try {
          const q = await create.mutateAsync(input);
          toast.success("Quotation created");
          router.push(`/quotations/${q.id}`);
        } catch (e) {
          toast.error(e instanceof ApiError ? e.message : "Failed to create quotation");
        }
      }}
    />
  );
}
