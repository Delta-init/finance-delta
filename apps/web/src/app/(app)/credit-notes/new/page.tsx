"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { createCreditNoteSchema, type CreateCreditNoteInput } from "@delta/shared";
import { useCreateCreditNote } from "@/features/credit-notes/api";
import { useInvoices, useInvoice } from "@/features/invoices/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SuggestInput } from "@/components/ui/suggest-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/lib/toast";
import { Plus, Trash2, ArrowLeft } from "lucide-react";
import Link from "next/link";

const ELIGIBLE_STATUSES = new Set(["sent", "viewed", "partial", "paid"]);

export default function NewCreditNotePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const prefilledInvoiceId = searchParams.get("invoiceId") ?? "";

  // Fetch the full list (no status filter — API doesn't support comma-separated values)
  const { data: invoiceList } = useInvoices({ limit: "200" });

  // If we have a prefilled ID, eagerly fetch that invoice so we can show its label
  // in the Select trigger before the list finishes loading
  const { data: prefilledInvoice } = useInvoice(prefilledInvoiceId || undefined);

  const create = useCreateCreditNote();

  const {
    register,
    handleSubmit,
    control,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<CreateCreditNoteInput>({
    resolver: zodResolver(createCreditNoteSchema),
    defaultValues: {
      invoiceId: prefilledInvoiceId,
      reason: "",
      lineItems: [{ description: "", quantity: 1, unitPriceMinor: 0, discountPct: 0, taxPct: 0 }],
    },
  });

  // Re-apply the prefilled value once the list has loaded so Radix can match the SelectItem
  const listLoaded = !!invoiceList;
  useEffect(() => {
    if (listLoaded && prefilledInvoiceId) {
      setValue("invoiceId", prefilledInvoiceId, { shouldValidate: false });
    }
  }, [listLoaded, prefilledInvoiceId, setValue]);

  const { fields, append, remove } = useFieldArray({ control, name: "lineItems" });

  // Client-side filter to only show eligible invoices
  const eligibleInvoices = invoiceList?.data.filter((inv) => ELIGIBLE_STATUSES.has(inv.status)) ?? [];

  // Build items for the Select. If the prefilled invoice isn't in the eligible list yet
  // (list still loading), add it so the trigger can display its label immediately.
  const selectItems = (() => {
    if (!prefilledInvoiceId || !prefilledInvoice) return eligibleInvoices;
    const alreadyIn = eligibleInvoices.some((inv) => inv.id === prefilledInvoiceId);
    if (alreadyIn) return eligibleInvoices;
    return [prefilledInvoice, ...eligibleInvoices];
  })();

  async function onSubmit(data: CreateCreditNoteInput) {
    try {
      const cn = await create.mutateAsync(data);
      toast.success("Credit note created");
      router.push(`/credit-notes/${cn.id}`);
    } catch {
      toast.error("Failed to create credit note");
    }
  }

  return (
    <div className="space-y-6 max-w-3xl p-6">
      <div className="flex items-center gap-2 text-sm text-foreground-muted">
        <Link href="/credit-notes" className="flex items-center gap-1 hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Credit Notes
        </Link>
        <span>/</span>
        <span className="font-medium text-foreground">New Credit Note</span>
      </div>

      <h1 className="text-xl font-semibold">New Credit Note</h1>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        {/* Invoice selector */}
        <div className="rounded-xl border border-border bg-card p-5 space-y-4">
          <h2 className="text-sm font-semibold">Invoice</h2>
          <div>
            <label className="mb-1 block text-xs font-medium text-foreground-muted">Invoice *</label>
            <Select
              value={watch("invoiceId")}
              onValueChange={(v) => setValue("invoiceId", v, { shouldValidate: true })}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select invoice…" />
              </SelectTrigger>
              <SelectContent>
                {selectItems.map((inv) => (
                  <SelectItem key={inv.id} value={inv.id}>
                    {inv.invoiceNumber} — {inv.customerName}
                  </SelectItem>
                ))}
                {selectItems.length === 0 && (
                  <div className="px-3 py-2 text-sm text-foreground-muted">
                    {invoiceList ? "No eligible invoices found" : "Loading invoices…"}
                  </div>
                )}
              </SelectContent>
            </Select>
            {errors.invoiceId && <p className="mt-1 text-xs text-danger">{errors.invoiceId.message}</p>}
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-foreground-muted">Reason *</label>
            <textarea
              {...register("reason")}
              placeholder="Describe the reason for this credit note…"
              rows={3}
              className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm shadow-xs focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
            />
            {errors.reason && <p className="mt-1 text-xs text-danger">{errors.reason.message}</p>}
          </div>
        </div>

        {/* Line items */}
        <div className="rounded-xl border border-border bg-card p-5 space-y-3">
          <h2 className="text-sm font-semibold">Line Items</h2>
          {fields.map((field, i) => (
            <div key={field.id} className="grid grid-cols-12 gap-2 items-end text-sm">
              <div className="col-span-4">
                {i === 0 && <label className="mb-1 block text-xs font-medium text-foreground-muted">Description</label>}
                <SuggestInput field="lineDescription" value={watch(`lineItems.${i}.description`) ?? ""} onChange={(v) => setValue(`lineItems.${i}.description`, v, { shouldDirty: true })} placeholder="Item description" />
              </div>
              <div className="col-span-2">
                {i === 0 && <label className="mb-1 block text-xs font-medium text-foreground-muted">Qty</label>}
                <Input type="number" min={0.001} step="any" {...register(`lineItems.${i}.quantity`, { valueAsNumber: true })} />
              </div>
              <div className="col-span-2">
                {i === 0 && <label className="mb-1 block text-xs font-medium text-foreground-muted">Unit Price</label>}
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  placeholder="0.00"
                  {...register(`lineItems.${i}.unitPriceMinor`, { setValueAs: (v) => Math.round(Number(v) * 100) })}
                />
              </div>
              <div className="col-span-1">
                {i === 0 && <label className="mb-1 block text-xs font-medium text-foreground-muted">Disc %</label>}
                <Input type="number" min={0} max={100} step="0.01" placeholder="0" {...register(`lineItems.${i}.discountPct`, { valueAsNumber: true })} />
              </div>
              <div className="col-span-1">
                {i === 0 && <label className="mb-1 block text-xs font-medium text-foreground-muted">Tax %</label>}
                <Input type="number" min={0} max={100} step="0.01" placeholder="0" {...register(`lineItems.${i}.taxPct`, { valueAsNumber: true })} />
              </div>
              <div className="col-span-2 flex items-end justify-end pb-0.5">
                <button
                  type="button"
                  onClick={() => remove(i)}
                  className="rounded p-1.5 text-foreground-muted hover:bg-danger/10 hover:text-danger"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
          {errors.lineItems && typeof errors.lineItems.message === "string" && (
            <p className="text-xs text-danger">{errors.lineItems.message}</p>
          )}
          <button
            type="button"
            onClick={() => append({ description: "", quantity: 1, unitPriceMinor: 0, discountPct: 0, taxPct: 0 })}
            className="flex items-center gap-1.5 text-xs text-primary hover:underline"
          >
            <Plus className="h-3.5 w-3.5" /> Add line
          </button>
        </div>

        <div className="flex justify-end gap-2">
          <Link href="/credit-notes">
            <Button type="button" variant="ghost" size="sm">Cancel</Button>
          </Link>
          <Button type="submit" size="sm" loading={isSubmitting || create.isPending}>
            Create Credit Note
          </Button>
        </div>
      </form>
    </div>
  );
}
