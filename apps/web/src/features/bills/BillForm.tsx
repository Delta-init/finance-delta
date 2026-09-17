"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm, useFieldArray, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ArrowLeft, Plus, Trash2, Paperclip, Upload, FileText } from "lucide-react";
import { formatMoney, toMinor } from "@delta/shared";
import type { CreateBillInput } from "@delta/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SuggestInput } from "@/components/ui/suggest-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ApiError, api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useVendors } from "@/features/vendors/api";
import { useCreateBill, useUpdateBill } from "@/features/bills/api";
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
export type BillFormValues = z.infer<typeof formSchema>;

function emptyLine() {
  return { description: "", quantity: 1, unitPrice: 0, discountPct: 0, taxPct: 0 };
}

function formatBytes(bytes: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const ACCEPTED_UPLOAD = "image/jpeg,image/png,image/webp,image/gif,application/pdf";
const ACCEPTED_TYPE_SET = new Set(ACCEPTED_UPLOAD.split(","));
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

interface BillFormProps {
  mode: "create" | "edit";
  billId?: string;
  initialValues?: Partial<BillFormValues>;
  /**
   * What has already been paid against this bill, for an edit.
   *
   * A bill with payments can be edited, but not down to less than has already
   * gone out — the balance would go negative and the books would stop adding
   * up. The form needs the figure to say so before the save rather than after.
   */
  amountPaidMinor?: number;
}

export function BillForm({ mode, billId, initialValues, amountPaidMinor = 0 }: BillFormProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sourcePOId = searchParams.get("poId") ?? "";
  const createBill = useCreateBill();
  const updateBill = useUpdateBill(billId ?? "");
  const { data: vendorData } = useVendors({ limit: "200" });
  const vendors = vendorData?.data ?? [];
  const { baseCurrency: orgCurrency } = useCurrency();
  const isEdit = mode === "edit";

  const today = new Date().toISOString().slice(0, 10);
  const due30 = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);

  const backHref = isEdit && billId ? `/bills/${billId}` : "/bills";

  const { register, control, handleSubmit, watch, setValue, formState: { errors, isSubmitting } } =
    useForm<BillFormValues>({
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
        ...initialValues,
      },
    });

  const { fields, append, remove } = useFieldArray({ control, name: "lineItems" });
  const watchedLines = useWatch({ control, name: "lineItems" });
  const currency = watch("currency");

  const [stagedFiles, setStagedFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function onFilesPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = "";
    const valid = picked.filter((f) => {
      if (f.type && !ACCEPTED_TYPE_SET.has(f.type)) {
        toast.error(`"${f.name}" is not a supported type (JPG, PNG, WebP, GIF or PDF)`);
        return false;
      }
      if (f.size > MAX_UPLOAD_BYTES) {
        toast.error(`"${f.name}" exceeds the 10 MB limit`);
        return false;
      }
      return true;
    });
    if (valid.length) setStagedFiles((prev) => [...prev, ...valid]);
  }

  useEffect(() => {
    // In create mode, follow the org's display currency. In edit mode, keep the saved currency.
    if (!isEdit) setValue("currency", orgCurrency, { shouldDirty: false });
  }, [orgCurrency, isEdit]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // The same figure the API will compute, so the warning and the refusal agree.
  const nextTotalMinor = toMinor(totals.subtotal + totals.tax);
  const belowPaid = amountPaidMinor > 0 && nextTotalMinor < amountPaidMinor;

  async function onSubmit(values: BillFormValues) {
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
      if (isEdit && billId) {
        await updateBill.mutateAsync(input);
        toast.success("Bill updated");
        router.push(`/bills/${billId}`);
        return;
      }

      const bill = await createBill.mutateAsync(input);

      // Upload any staged attachments against the freshly-created bill (best effort).
      let failed = 0;
      for (const file of stagedFiles) {
        const form = new FormData();
        form.append("file", file);
        try {
          await api.postForm(`bills/${bill.id}/attachments`, form);
        } catch {
          failed += 1;
        }
      }
      if (failed > 0) {
        toast.error(`Bill created, but ${failed} attachment${failed > 1 ? "s" : ""} failed to upload. You can re-add them on the bill page.`);
      } else {
        toast.success("Bill created");
      }
      router.push(`/bills/${bill.id}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : `Failed to ${isEdit ? "update" : "create"} bill`);
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Link href={backHref} className="rounded-md p-1.5 text-foreground-muted hover:bg-surface-muted">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <h1 className="text-xl font-semibold">{isEdit ? "Edit Bill" : "New Bill"}</h1>
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
              <Select key={currency} value={currency} onValueChange={(v) => setValue("currency", v)}>
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
            {!isEdit && (
              <div className="flex items-center gap-2 pt-6">
                <input
                  type="checkbox"
                  id="requiresApproval"
                  {...register("requiresApproval")}
                  className="h-4 w-4 rounded border-border"
                />
                <Label htmlFor="requiresApproval" className="cursor-pointer">Requires approval before payment</Label>
              </div>
            )}
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
                        <SuggestInput field="lineDescription" value={watch(`lineItems.${i}.description`) ?? ""} onChange={(v) => setValue(`lineItems.${i}.description`, v, { shouldDirty: true })} placeholder="Item description" className="h-8" />
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
              {/* Only when money has already gone out, which is the only time
                  the total is not free to be anything. */}
              {amountPaidMinor > 0 && (
                <>
                  <div className="flex justify-between">
                    <span className="text-foreground-muted">Already paid</span>
                    <span className="font-medium">{formatMoney(amountPaidMinor, currency)}</span>
                  </div>
                  <div className="flex justify-between border-t border-border pt-1.5">
                    <span className="text-foreground-muted">Balance after saving</span>
                    <span
                      className={`font-semibold ${belowPaid ? "text-danger" : ""}`}
                    >
                      {formatMoney(nextTotalMinor - amountPaidMinor, currency)}
                    </span>
                  </div>
                </>
              )}
            </div>
          </div>

          {belowPaid && (
            <div className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2.5 text-xs text-danger">
              This bill already has {formatMoney(amountPaidMinor, currency)} paid against it, so it
              cannot be saved for less than that. Raise a vendor credit for the difference, or
              remove the payment first.
            </div>
          )}
        </div>

        {mode === "create" && (
          <div className="rounded-lg border border-border bg-surface p-5 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Paperclip className="h-4 w-4 text-foreground-muted" />
                <Label className="m-0">Attachments</Label>
              </div>
              <input ref={fileInputRef} type="file" multiple accept={ACCEPTED_UPLOAD} className="hidden" onChange={onFilesPicked} />
              <Button type="button" variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
                <Upload className="h-3.5 w-3.5" /> Add files
              </Button>
            </div>
            {stagedFiles.length === 0 ? (
              <p className="text-sm text-foreground-muted">Attach a bill PDF, receipt, or supporting document (JPG, PNG, WebP, GIF or PDF, max 10&nbsp;MB each). Files upload when you create the bill.</p>
            ) : (
              <ul className="divide-y divide-border rounded-md border border-border">
                {stagedFiles.map((f, i) => (
                  <li key={`${f.name}-${i}`} className="flex items-center gap-3 px-3 py-2">
                    <FileText className="h-4 w-4 shrink-0 text-foreground-muted" />
                    <span className="flex-1 truncate text-sm">{f.name}</span>
                    <span className="text-xs text-foreground-muted">{formatBytes(f.size)}</span>
                    <button
                      type="button"
                      onClick={() => setStagedFiles((prev) => prev.filter((_, idx) => idx !== i))}
                      className="rounded p-1 text-foreground-muted hover:bg-danger/10 hover:text-danger"
                      title="Remove"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="rounded-lg border border-border bg-surface p-5 space-y-1.5">
          <Label>Notes</Label>
          <textarea {...register("notes")} rows={3} placeholder="Internal notes…"
            className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-foreground-subtle focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30" />
        </div>

        <div className="flex justify-end gap-3">
          <Button type="button" variant="ghost" onClick={() => router.push(backHref)}>Cancel</Button>
          <Button type="submit" loading={isSubmitting} disabled={belowPaid}>
            {isEdit ? "Save Changes" : "Create bill"}
          </Button>
        </div>
      </form>
    </div>
  );
}
