"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useForm, useFieldArray, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import { formatMoney, toMinor } from "@delta/shared";
import type { CreateBillInput } from "@delta/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useVendors } from "@/features/vendors/api";
import { useCreateBill } from "@/features/bills/api";
import { useCurrency } from "@/lib/currency-context";

const CURRENCIES = ["AED", "USD", "EUR", "GBP", "INR", "SAR", "QAR", "KWD", "BHD", "OMR"];
const PAYMENT_TERMS = ["Net 15", "Net 30", "Net 45", "Net 60", "Due on receipt"];

const lineSchema = z.object({
  description: z.string().min(1, "Required"),
  quantity: z.coerce.number().positive("Must be > 0"),
  unitPrice: z.coerce.number().min(0),
  discountPct: z.coerce.number().min(0).max(100).default(0),
  taxPct: z.coerce.number().min(0).max(100).default(0),
});

const formSchema = z.object({
  vendorId: z.string().min(1, "Vendor is required"),
  sourcePOId: z.string().optional(),
  billDate: z.string().min(1, "Bill date required"),
  dueDate: z.string().min(1, "Due date required"),
  currency: z.string().default("AED"),
  paymentTerms: z.string().optional().default(""),
  notes: z.string().optional().default(""),
  requiresApproval: z.boolean().default(false),
  lineItems: z.array(lineSchema).min(1, "At least one line item required"),
});
type FormValues = z.infer<typeof formSchema>;

function emptyLine() {
  return { description: "", quantity: 1, unitPrice: 0, discountPct: 0, taxPct: 0 };
}

export default function NewBillPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sourcePOId = searchParams.get("poId") ?? "";
  const createBill = useCreateBill();
  const { data: vendorData } = useVendors({ limit: "200" });
  const vendors = vendorData?.data ?? [];
  const { currency: orgCurrency } = useCurrency();

  const today = new Date().toISOString().slice(0, 10);
  const due30 = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);

  const { register, control, handleSubmit, watch, setValue, formState: { errors, isSubmitting } } =
    useForm<FormValues>({
      resolver: zodResolver(formSchema),
      defaultValues: {
        vendorId: "",
        sourcePOId: sourcePOId || undefined,
        billDate: today,
        dueDate: due30,
        currency: orgCurrency,
        paymentTerms: "",
        notes: "",
        requiresApproval: false,
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
    const input: CreateBillInput = {
      vendorId: values.vendorId,
      sourcePOId: values.sourcePOId || undefined,
      billDate: values.billDate,
      dueDate: values.dueDate,
      currency: values.currency,
      paymentTerms: values.paymentTerms ?? "",
      notes: values.notes ?? "",
      requiresApproval: values.requiresApproval,
      lineItems: values.lineItems.map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unitPriceMinor: toMinor(l.unitPrice),
        discountPct: l.discountPct,
        taxPct: l.taxPct,
      })),
    };
    try {
      const bill = await createBill.mutateAsync(input);
      toast.success("Bill created");
      router.push(`/bills/${bill.id}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to create bill");
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <button onClick={() => router.back()} className="rounded-md p-1.5 text-foreground-muted hover:bg-surface-muted">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <h1 className="text-xl font-semibold">New Bill</h1>
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
              <Label>Bill Date *</Label>
              <Input type="date" {...register("billDate")} />
              {errors.billDate && <p className="text-xs text-danger">{errors.billDate.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label>Due Date *</Label>
              <Input type="date" {...register("dueDate")} />
              {errors.dueDate && <p className="text-xs text-danger">{errors.dueDate.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label>Payment Terms</Label>
              <Select value={watch("paymentTerms") ?? ""} onValueChange={(v) => setValue("paymentTerms", v)}>
                <SelectTrigger><SelectValue placeholder="Select terms" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="">None</SelectItem>
                  {PAYMENT_TERMS.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2 pt-6">
              <input
                type="checkbox"
                id="requiresApproval"
                {...register("requiresApproval")}
                className="h-4 w-4 rounded border-border"
              />
              <Label htmlFor="requiresApproval" className="cursor-pointer">Requires approval before payment</Label>
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
                  const gross = (l?.quantity ?? 0) * (l?.unitPrice ?? 0);
                  const net = gross - gross * ((l?.discountPct ?? 0) / 100);
                  const lineTotal = net + net * ((l?.taxPct ?? 0) / 100);
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
          <textarea {...register("notes")} rows={3} placeholder="Internal notes…"
            className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-foreground-subtle focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30" />
        </div>

        <div className="flex justify-end gap-3">
          <Button type="button" variant="ghost" onClick={() => router.back()}>Cancel</Button>
          <Button type="submit" loading={isSubmitting}>Create bill</Button>
        </div>
      </form>
    </div>
  );
}
