"use client";

import { use } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { useBill } from "@/features/bills/api";
import { BillForm, type BillFormValues } from "@/features/bills/BillForm";

export default function EditBillPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: bill, isLoading } = useBill(id);

  if (isLoading) {
    return <div className="flex h-64 items-center justify-center text-foreground-muted">Loading…</div>;
  }
  if (!bill) {
    return <div className="flex h-64 items-center justify-center text-foreground-muted">Bill not found.</div>;
  }

  // Only a voided bill is off limits now, which mirrors the API guard. A bill
  // with payments against it is editable: money having moved is a reason to get
  // the bill right, not a reason to leave it wrong.
  if (bill.status === "voided") {
    const reason = "it has been voided";
    return (
      <div className="mx-auto max-w-4xl space-y-4 p-6">
        <div className="flex items-center gap-3">
          <Link href={`/bills/${id}`} className="rounded-md p-1.5 text-foreground-muted hover:bg-surface-muted">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <h1 className="text-xl font-semibold">Edit Bill</h1>
        </div>
        <div className="rounded-lg border border-border bg-surface p-6 text-sm text-foreground-muted">
          This bill can&apos;t be edited because <span className="font-medium text-foreground">{reason}</span>.
          <div className="mt-3">
            <Link href={`/bills/${id}`} className="text-primary hover:underline">Back to bill →</Link>
          </div>
        </div>
      </div>
    );
  }

  const initialValues: Partial<BillFormValues> = {
    vendorId: bill.vendorId,
    sourcePOId: bill.sourcePOId,
    billDate: bill.billDate,
    dueDate: bill.dueDate,
    currency: bill.currency,
    paymentTerms: bill.paymentTerms || "",
    notes: bill.notes || "",
    requiresApproval: false,
    lineItems: bill.lineItems.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPriceMinor / 100,
      discountPct: l.discountPct,
      taxPct: l.taxPct,
    })),
  };

  return (
    <BillForm
      mode="edit"
      billId={id}
      initialValues={initialValues}
      amountPaidMinor={bill.amountPaidMinor}
    />
  );
}
