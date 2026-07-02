"use client";

import { useRouter } from "next/navigation";
import { useForm, useFieldArray, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import { formatMoney, toMinor } from "@delta/shared";
import type { CreatePOInput } from "@delta/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useVendors } from "@/features/vendors/api";
import { useCreatePO } from "@/features/purchase-orders/api";

const CURRENCIES = ["AED", "USD", "EUR", "GBP", "INR", "SAR", "QAR", "KWD", "BHD", "OMR"];

const lineSchema = z.object({
  description: z.string().min(1, "Required"),
  quantity: z.coerce.number().positive("Must be > 0"),
  unitPrice: z.coerce.number().min(0),
  discountPct: z.coerce.number().min(0).max(100).default(0),
  taxPct: z.coerce.number().min(0).max(100).default(0),
});

const formSchema = z.object({
  vendorId: z.string().min(1, "Vendor is required"),
  issueDate: z.string().min(1, "Issue date required"),
  expectedDate: z.string().optional(),
  currency: z.string().default("AED"),
  notes: z.string().optional().default(""),
  lineItems: z.array(lineSchema).min(1, "At least one line item required"),
});
type FormValues = z.infer<typeof formSchema>;

function emptyLine() {
  return { description: "", quantity: 1, unitPrice: 0, discountPct: 0, taxPct: 0 };
}

function computeLine(l: { quantity: number; unitPrice: number; discountPct: number; taxPct: number }) {
  const gross = l.quantity * l.unitPrice;
  const discount = gross * (l.discountPct / 100);
  const net = gross - discount;
  const tax = net * (l.taxPct / 100);
  return net + tax;
}

export default function NewPurchaseOrderPage() {
  const router = useRouter();
  const createPO = useCreatePO();
  const { data: vendorData } = useVendors({ limit: "200" });
  const vendors = vendorData?.data ?? [];

  const { register, control, handleSubmit, watch, setValue, formState: { errors, isSubmitting } } =
    useForm<FormValues>({
      resolver: zodResolver(formSchema),
      defaultValues: {
        vendorId: "",
        issueDate: new Date().toISOString().slice(0, 10),
        expectedDate: "",
        currency: "AED",
        notes: "",
        lineItems: [emptyLine()],
      },
    });

  const { fields, append, remove } = useFieldArray({ control, name: "lineItems" });
  const watchedLines = useWatch({ control, name: "lineItems" });
  const currency = watch("currency");

  const totals = (watchedLines ?? []).reduce(
    (acc, l) => {
      const gross = (l.quantity ?? 0) * (l.unitPrice ?? 0);
      const discount = gross * ((l.discountPct ?? 0) / 100);
      const net = gross - discount;
      const tax = net * ((l.taxPct ?? 0) / 100);
      return { subtotal: acc.subtotal + net, tax: acc.tax + tax };
    },
    { subtotal: 0, tax: 0 },
  );

  async function onSubmit(values: FormValues) {
    const input: CreatePOInput = {
      vendorId: values.vendorId,
      issueDate: values.issueDate,
      expectedDate: values.expectedDate || undefined,
      currency: values.currency,
      notes: values.notes ?? "",
      lineItems: values.lineItems.map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unitPriceMinor: toMinor(l.unitPrice),
        discountPct: l.discountPct,
        taxPct: l.taxPct,
      })),
    };
    try {
      const po = await createPO.mutateAsync(input);
      toast.success("Purchase order created");
      router.push(`/purchase-orders/${po.id}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to create purchase order");
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <button onClick={() => router.back()} className="rounded-md p-1.5 text-foreground-muted hover:bg-surface-muted">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <h1 className="text-xl font-semibold">New Purchase Order</h1>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <div className="rounded-lg border border-border bg-surface p-5 space-y-4">
          <h2 className="text-sm font-semibold text-foreground-muted uppercase tracking-wider">Details</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Vendor *</Label>
              <Select value={watch("vendorId")} onValueChange={(v) => setValue("vendorId", v)}>
                <SelectTrigger><SelectValue placeholder="Select vendor" /></SelectTrigger>
                <SelectContent>
                  {vendors.map((v) => (
                    <SelectItem key={v.id} value={v.id}>{v.name}{v.companyName ? ` — ${v.companyName}` : ""}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.vendorId && <p className="text-xs text-danger">{errors.vendorId.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label>Currency</Label>
              <Select value={watch("currency")} onValueChange={(v) => setValue("currency", v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{CURRENCIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Issue Date *</Label>
              <Input type="date" {...register("issueDate")} />
              {errors.issueDate && <p className="text-xs text-danger">{errors.issueDate.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label>Expected Delivery</Label>
              <Input type="date" {...register("expectedDate")} />
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-surface p-5 space-y-4">
          <h2 className="text-sm font-semibold text-foreground-muted uppercase tracking-wider">Line Items</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-foreground-muted">
                  <th className="pb-2 font-medium w-[40%]">Description</th>
                  <th className="pb-2 font-medium text-right w-20">Qty</th>
                  <th className="pb-2 font-medium text-right w-28">Unit Price</th>
                  <th className="pb-2 font-medium text-right w-20">Disc %</th>
                  <th className="pb-2 font-medium text-right w-20">Tax %</th>
                  <th className="pb-2 font-medium text-right w-28">Total</th>
                  <th className="pb-2 w-8" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {fields.map((field, i) => {
                  const l = watchedLines?.[i];
                  const lineTotal = l ? computeLine(l) : 0;
                  return (
                    <tr key={field.id}>
                      <td className="py-2 pr-2">
                        <Input {...register(`lineItems.${i}.description`)} placeholder="Item description" className="h-8" />
                        {errors.lineItems?.[i]?.description && <p className="text-xs text-danger">{errors.lineItems[i].description?.message}</p>}
                      </td>
                      <td className="py-2 pr-2">
                        <Input type="number" step="0.01" {...register(`lineItems.${i}.quantity`)} className="h-8 text-right w-20" />
                      </td>
                      <td className="py-2 pr-2">
                        <Input type="number" step="0.01" {...register(`lineItems.${i}.unitPrice`)} className="h-8 text-right w-28" />
                      </td>
                      <td className="py-2 pr-2">
                        <Input type="number" step="0.01" {...register(`lineItems.${i}.discountPct`)} className="h-8 text-right w-20" />
                      </td>
                      <td className="py-2 pr-2">
                        <Input type="number" step="0.01" {...register(`lineItems.${i}.taxPct`)} className="h-8 text-right w-20" />
                      </td>
                      <td className="py-2 pr-2 text-right font-medium whitespace-nowrap">
                        {formatMoney(toMinor(lineTotal), currency)}
                      </td>
                      <td className="py-2">
                        <button type="button" onClick={() => remove(i)} className="rounded p-1 text-foreground-muted hover:bg-danger/10 hover:text-danger" disabled={fields.length === 1}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={() => append(emptyLine())}>
            <Plus className="h-4 w-4" /> Add line
          </Button>
          {errors.lineItems?.root && <p className="text-xs text-danger">{errors.lineItems.root.message}</p>}

          <div className="flex justify-end pt-2">
            <div className="w-64 space-y-1.5 text-sm">
              <div className="flex justify-between">
                <span className="text-foreground-muted">Subtotal</span>
                <span className="font-medium">{formatMoney(toMinor(totals.subtotal), currency)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-foreground-muted">Tax</span>
                <span className="font-medium">{formatMoney(toMinor(totals.tax), currency)}</span>
              </div>
              <div className="flex justify-between border-t border-border pt-1.5">
                <span className="font-semibold">Total</span>
                <span className="font-semibold">{formatMoney(toMinor(totals.subtotal + totals.tax), currency)}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-surface p-5 space-y-1.5">
          <Label>Notes</Label>
          <textarea {...register("notes")} rows={3} placeholder="Internal notes or instructions for the vendor…"
            className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-foreground-subtle focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30" />
        </div>

        <div className="flex justify-end gap-3">
          <Button type="button" variant="ghost" onClick={() => router.back()}>Cancel</Button>
          <Button type="submit" loading={isSubmitting}>Create purchase order</Button>
        </div>
      </form>
    </div>
  );
}
