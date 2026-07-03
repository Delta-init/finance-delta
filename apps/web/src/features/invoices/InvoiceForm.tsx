"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  useForm,
  useFieldArray,
  useWatch,
  Controller,
  type Control,
  type UseFormRegister,
  type UseFormSetValue,
} from "react-hook-form";

import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Reorder, useDragControls, motion } from "framer-motion";
import { Trash2, Plus, GripVertical, ArrowLeft, X } from "lucide-react";
import {
  TAX_CODES,
  RECURRING_FREQUENCIES,
  computeInvoiceLine,
  sumInvoiceTotals,
  toMinor,
  formatMoney,
  type CreateInvoiceInput,
  type Invoice,
  type TaxCode,
} from "@delta/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DatePicker } from "@/components/ui/date-picker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { FadeIn } from "@/components/ui/motion";
import { TagPicker } from "@/features/tags/TagPicker";
import { useCustomers } from "@/features/customers/api";
import { QuickCreateCustomerModal } from "@/features/customers/QuickCreateCustomerModal";
import { useUsers } from "@/features/users/api";
import { useTaxConfig } from "@/features/organization/api";
import { useCurrency } from "@/lib/currency-context";

// ── Form schema ──────────────────────────────────────────────────────────────

const taxSchema = z.object({
  code: z.string().min(1),
  rate: z.coerce.number().min(0).max(100),
});

const lineSchema = z.object({
  description: z.string().min(1, "Required"),
  quantity: z.coerce.number().positive(),
  unitPrice: z.coerce.number().min(0),
  discountPct: z.coerce.number().min(0).max(100),
  taxes: z.array(taxSchema).default([]),
});

const progressSchema = z.object({
  contractDescription: z.string().min(1, "Required"),
  contractValueMinor: z.coerce.number().int().min(0),
  stageName: z.string().min(1, "Required"),
  stageNumber: z.coerce.number().int().min(1),
  pctOfContract: z.coerce.number().min(0).max(100),
});

const recurringSchema = z.object({
  frequency: z.enum(RECURRING_FREQUENCIES),
  startDate: z.string().min(1, "Required"),
  endDate: z.string().optional(),
  isActive: z.boolean().default(true),
});

const formSchema = z.object({
  customerId: z.string().min(1, "Select a customer"),
  salespersonId: z.string().min(1, "Select a salesperson"),
  reference: z.string().optional().default(""),
  issueDate: z.string().min(1, "Required"),
  dueDate: z.string().min(1, "Required"),
  notes: z.string().optional(),
  terms: z.string().optional(),
  locale: z.enum(["en", "ar", "fr"]).default("en"),
  tagIds: z.array(z.string()).optional().default([]),
  lineItems: z.array(lineSchema).min(1, "Add at least one line"),
  hasProgress: z.boolean().default(false),
  progress: progressSchema.optional(),
  hasRecurring: z.boolean().default(false),
  recurring: recurringSchema.optional(),
  taxInclusive: z.boolean().default(false),
});

type FormValues = z.infer<typeof formSchema>;

// ── Helpers ──────────────────────────────────────────────────────────────────

const GRID = "28px minmax(160px,1fr) 70px 120px 64px 80px 100px 36px";
const today = () => new Date().toISOString().slice(0, 10);
const inDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const emptyLine = (taxes: { code: string; rate: number }[] = []) => ({
  description: "", quantity: 1, unitPrice: 0, discountPct: 0, taxes,
});

function fromInvoice(inv: Invoice): FormValues {
  return {
    customerId: inv.customerId,
    salespersonId: inv.salespersonId,
    reference: inv.reference,
    issueDate: inv.issueDate,
    dueDate: inv.dueDate,
    notes: inv.notes,
    terms: inv.terms,
    locale: (inv.locale as "en" | "ar" | "fr") ?? "en",
    tagIds: inv.tags.map((t) => t.id),
    lineItems: inv.lineItems.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPriceMinor / 100,
      discountPct: l.discountPct,
      taxes: l.taxes.map((t) => ({ code: t.code, rate: t.rate })),
    })),
    hasProgress: !!inv.progress,
    progress: inv.progress ?? undefined,
    hasRecurring: !!inv.recurring,
    taxInclusive: inv.taxInclusive ?? false,
    recurring: inv.recurring
      ? {
          frequency: inv.recurring.frequency,
          startDate: inv.recurring.startDate,
          endDate: inv.recurring.endDate,
          isActive: inv.recurring.isActive,
        }
      : undefined,
  };
}

function toApiInput(v: FormValues): CreateInvoiceInput {
  return {
    customerId: v.customerId,
    salespersonId: v.salespersonId,
    reference: v.reference ?? "",
    issueDate: v.issueDate,
    dueDate: v.dueDate,
    notes: v.notes ?? "",
    terms: v.terms ?? "",
    locale: v.locale,
    tagIds: v.tagIds ?? [],
    lineItems: v.lineItems.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unitPriceMinor: toMinor(l.unitPrice),
      discountPct: l.discountPct,
      taxes: l.taxes,
    })),
    progress: v.hasProgress && v.progress ? v.progress : null,
    recurring: v.hasRecurring && v.recurring ? v.recurring : null,
    taxInclusive: v.taxInclusive ?? false,
  };
}

// ── Component ─────────────────────────────────────────────────────────────────

export function InvoiceForm({
  initial,
  title,
  submitLabel,
  onSubmit,
}: {
  initial?: Invoice;
  title: string;
  submitLabel: string;
  onSubmit: (input: CreateInvoiceInput) => Promise<void>;
}) {
  const router = useRouter();
  const { currency: orgCurrency } = useCurrency();
  const { data: customers } = useCustomers({ pageSize: 100, sort: "name", dir: "asc" });
  const { data: users } = useUsers({ pageSize: 100, sort: "name", dir: "asc" });
  const { data: taxConfig } = useTaxConfig();
  const [error, setError] = useState<string | null>(null);
  const [customerModalOpen, setCustomerModalOpen] = useState(false);

  const firstRate = taxConfig?.taxRates[0];
  const defaultTaxes = firstRate ? [{ code: firstRate.code, rate: firstRate.rate }] : [];

  const {
    register,
    control,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: initial
      ? fromInvoice(initial)
      : {
          customerId: "",
          salespersonId: "",
          reference: "",
          issueDate: today(),
          dueDate: inDays(30),
          notes: "",
          terms: "",
          locale: "en",
          tagIds: [],
          lineItems: [emptyLine()],
          hasProgress: false,
          hasRecurring: false,
          taxInclusive: false,
        },
  });

  const { fields, append, remove, move } = useFieldArray({ control, name: "lineItems" });
  const currency = initial?.currency ?? orgCurrency;
  const hasProgress = watch("hasProgress");
  const hasRecurring = watch("hasRecurring");
  const locale = watch("locale");
  const taxInclusive = watch("taxInclusive");

  const handleReorder = (newOrder: typeof fields) => {
    const oldIds = fields.map((f) => f.id);
    const newIds = newOrder.map((f) => f.id);
    for (let i = 0; i < newIds.length; i++) {
      if (newIds[i] !== oldIds[i]) {
        const from = oldIds.indexOf(newIds[i]!);
        if (from !== -1 && from !== i) move(from, i);
        break;
      }
    }
  };

  async function submit(values: FormValues) {
    setError(null);
    try {
      await onSubmit(toApiInput(values));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save invoice");
    }
  }

  return (
    <>
      <QuickCreateCustomerModal
        open={customerModalOpen}
        onClose={() => setCustomerModalOpen(false)}
        onCreated={(id) => {
          setValue("customerId", id, { shouldValidate: true });
          setCustomerModalOpen(false);
        }}
      />
    <form onSubmit={handleSubmit(submit)}>
      {/* Top bar */}
      <div className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-border bg-surface/85 px-6 py-3 backdrop-blur-md">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => router.back()}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-foreground-muted transition-colors hover:bg-surface-muted hover:text-foreground"
            aria-label="Back"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <h2 className="text-base font-semibold tracking-tight">{title}</h2>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" onClick={() => router.back()}>Cancel</Button>
          <Button type="submit" disabled={isSubmitting}>{isSubmitting ? "Saving…" : submitLabel}</Button>
        </div>
      </div>

      <div className="space-y-6 p-6">
        {/* Header fields */}
        <FadeIn className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>Customer *</Label>
              <button
                type="button"
                onClick={() => setCustomerModalOpen(true)}
                className="text-xs text-primary hover:underline flex items-center gap-0.5"
              >
                <Plus className="h-3 w-3" /> New
              </button>
            </div>
            <Controller
              control={control}
              name="customerId"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger><SelectValue placeholder="Select a customer…" /></SelectTrigger>
                  <SelectContent>
                    {customers?.data.map((c) => (
                      <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            {errors.customerId && <p className="text-xs text-danger">{errors.customerId.message}</p>}
          </div>

          <div className="space-y-1.5">
            <Label>Salesperson *</Label>
            <Controller
              control={control}
              name="salespersonId"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger><SelectValue placeholder="Select a salesperson…" /></SelectTrigger>
                  <SelectContent>
                    {users?.data.map((u) => (
                      <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            {errors.salespersonId && <p className="text-xs text-danger">{errors.salespersonId.message}</p>}
          </div>

          <div className="space-y-1.5">
            <Label>Reference / PO#</Label>
            <Input {...register("reference")} placeholder="e.g. PO-1234" />
          </div>

          <div className="space-y-1.5">
            <Label>Tags</Label>
            <Controller
              control={control}
              name="tagIds"
              render={({ field }) => (
                <TagPicker value={field.value ?? []} onChange={field.onChange} />
              )}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Issue date *</Label>
            <Controller
              control={control}
              name="issueDate"
              render={({ field }) => <DatePicker value={field.value} onChange={field.onChange} className="w-full" />}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Due date *</Label>
            <Controller
              control={control}
              name="dueDate"
              render={({ field }) => <DatePicker value={field.value} onChange={field.onChange} className="w-full" />}
            />
          </div>
        </FadeIn>

        {/* Line items */}
        <FadeIn delay={0.05} className="space-y-2">
          <Label>Line items</Label>
          <div className="flex items-center gap-2 mb-3">
            <label className="flex items-center gap-2 cursor-pointer select-none text-sm text-foreground-muted">
              <input
                type="checkbox"
                {...register("taxInclusive")}
                className="h-4 w-4 rounded border-border accent-primary"
              />
              Prices include tax
            </label>
          </div>
          <div className="overflow-x-auto rounded-lg border border-border">
            <div className="min-w-[720px]">
              <div
                className="grid items-center gap-2 border-b border-border bg-surface-muted px-3 py-2 text-xs font-medium uppercase tracking-wide text-foreground-subtle"
                style={{ gridTemplateColumns: GRID }}
              >
                <span />
                <span>Description</span>
                <span>Qty</span>
                <span>Unit price</span>
                <span>Disc %</span>
                <span>{taxConfig?.taxLabel ?? "Tax"}</span>
                <span className="text-right">Amount</span>
                <span />
              </div>
              <Reorder.Group axis="y" values={fields} onReorder={handleReorder} as="div">
                {fields.map((field, i) => (
                  <LineRow
                    key={field.id}
                    value={field}
                    index={i}
                    register={register}
                    control={control}
                    setValue={setValue}
                    currency={currency}
                    taxInclusive={taxInclusive}
                    canRemove={fields.length > 1}
                    onRemove={() => remove(i)}
                  />
                ))}
              </Reorder.Group>
            </div>
          </div>
          {errors.lineItems && <p className="text-xs text-danger">{errors.lineItems.message}</p>}
          <Button type="button" variant="outline" size="sm" onClick={() => append(emptyLine(defaultTaxes))}>
            <Plus className="h-4 w-4" /> Add line
          </Button>
        </FadeIn>

        {/* Notes / Terms / Totals */}
        <FadeIn delay={0.1} className="flex flex-col gap-6 lg:flex-row lg:justify-between">
          <div className="flex-1 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="notes">Notes</Label>
              <textarea
                id="notes"
                rows={3}
                className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm shadow-xs focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
                {...register("notes")}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="terms">Terms</Label>
              <textarea
                id="terms"
                rows={2}
                className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm shadow-xs focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
                {...register("terms")}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Print Language</Label>
              <Select value={locale} onValueChange={(v) => setValue("locale", v as "en" | "ar" | "fr")}>
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="en">English</SelectItem>
                  <SelectItem value="ar">Arabic (عربي)</SelectItem>
                  <SelectItem value="fr">French (Français)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <Totals control={control} currency={currency} taxInclusive={taxInclusive} />
        </FadeIn>

        {/* Progress invoicing */}
        <FadeIn delay={0.12}>
          <div className="rounded-lg border border-border bg-surface p-4 space-y-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-border accent-primary"
                {...register("hasProgress")}
              />
              <span className="text-sm font-medium">Progress invoice (milestone billing)</span>
            </label>
            {hasProgress && (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <div className="space-y-1.5 lg:col-span-2">
                  <Label>Contract description</Label>
                  <Input {...register("progress.contractDescription")} placeholder="e.g. Website Redesign Project" />
                  {errors.progress?.contractDescription && <p className="text-xs text-danger">{errors.progress.contractDescription.message}</p>}
                </div>
                <div className="space-y-1.5">
                  <Label>Contract total ({currency})</Label>
                  <Input type="number" step="0.01" {...register("progress.contractValueMinor", { setValueAs: (v) => Math.round(Number(v) * 100) })} placeholder="0.00" />
                </div>
                <div className="space-y-1.5">
                  <Label>Stage name</Label>
                  <Input {...register("progress.stageName")} placeholder="e.g. Phase 1 – Design" />
                  {errors.progress?.stageName && <p className="text-xs text-danger">{errors.progress.stageName.message}</p>}
                </div>
                <div className="space-y-1.5">
                  <Label>Stage #</Label>
                  <Input type="number" min={1} {...register("progress.stageNumber")} />
                </div>
                <div className="space-y-1.5">
                  <Label>% of contract</Label>
                  <Input type="number" min={0} max={100} step="0.01" {...register("progress.pctOfContract")} placeholder="e.g. 30" />
                </div>
              </div>
            )}
          </div>
        </FadeIn>

        {/* Recurring */}
        <FadeIn delay={0.14}>
          <div className="rounded-lg border border-border bg-surface p-4 space-y-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-border accent-primary"
                {...register("hasRecurring")}
              />
              <span className="text-sm font-medium">Recurring invoice</span>
            </label>
            {hasRecurring && (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="space-y-1.5">
                  <Label>Frequency</Label>
                  <Controller
                    control={control}
                    name="recurring.frequency"
                    render={({ field }) => (
                      <Select value={field.value ?? "monthly"} onValueChange={field.onChange}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {RECURRING_FREQUENCIES.map((f) => (
                            <SelectItem key={f} value={f} className="capitalize">{f}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Start date</Label>
                  <Controller
                    control={control}
                    name="recurring.startDate"
                    render={({ field }) => <DatePicker value={field.value ?? ""} onChange={field.onChange} className="w-full" />}
                  />
                  {errors.recurring?.startDate && <p className="text-xs text-danger">{errors.recurring.startDate.message}</p>}
                </div>
                <div className="space-y-1.5">
                  <Label>End date (optional)</Label>
                  <Controller
                    control={control}
                    name="recurring.endDate"
                    render={({ field }) => <DatePicker value={field.value ?? ""} onChange={field.onChange} clearable className="w-full" />}
                  />
                </div>
              </div>
            )}
          </div>
        </FadeIn>

        {error && <p className="text-sm text-danger">{error}</p>}
      </div>
    </form>
    </>
  );
}

// ── Line row ──────────────────────────────────────────────────────────────────

function LineRow({
  value,
  index,
  register,
  control,
  setValue,
  currency,
  taxInclusive,
  canRemove,
  onRemove,
}: {
  value: { id: string };
  index: number;
  register: UseFormRegister<FormValues>;
  control: Control<FormValues>;
  setValue: UseFormSetValue<FormValues>;
  currency: string;
  taxInclusive: boolean;
  canRemove: boolean;
  onRemove: () => void;
}) {
  const controls = useDragControls();
  return (
    <Reorder.Item
      value={value}
      dragListener={false}
      dragControls={controls}
      as="div"
      className="grid items-center gap-2 border-b border-border bg-surface px-3 py-1.5 last:border-0"
      style={{ gridTemplateColumns: GRID }}
      whileDrag={{ scale: 1.01, boxShadow: "var(--shadow-md)" }}
    >
      <button
        type="button"
        onPointerDown={(e) => controls.start(e)}
        className="flex h-8 w-7 cursor-grab touch-none items-center justify-center rounded text-foreground-subtle hover:text-foreground active:cursor-grabbing"
        aria-label="Drag to reorder"
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <Input className="h-8" {...register(`lineItems.${index}.description`)} />
      <Input className="h-8" type="number" step="any" {...register(`lineItems.${index}.quantity`)} />
      <Input className="h-8" type="number" step="0.01" {...register(`lineItems.${index}.unitPrice`)} />
      <Input className="h-8" type="number" step="any" {...register(`lineItems.${index}.discountPct`)} />
      <TaxCell control={control} index={index} setValue={setValue} />
      <div className="text-right">
        <LineAmount control={control} index={index} currency={currency} taxInclusive={taxInclusive} />
      </div>
      <div className="text-right">
        {canRemove && (
          <button type="button" onClick={onRemove} className="text-foreground-subtle hover:text-danger" aria-label="Remove line">
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>
    </Reorder.Item>
  );
}

// ── Tax popover cell ──────────────────────────────────────────────────────────

function TaxCell({
  control,
  index,
  setValue,
}: {
  control: Control<FormValues>;
  index: number;
  setValue: UseFormSetValue<FormValues>;
}) {
  const taxes = useWatch({ control, name: `lineItems.${index}.taxes` }) ?? [];
  const [code, setCode] = useState<TaxCode>("VAT");
  const [rate, setRate] = useState("5");

  const totalPct = taxes.reduce((s, t) => s + (Number(t.rate) || 0), 0);

  const add = () => {
    const r = parseFloat(rate);
    if (r > 0) {
      setValue(`lineItems.${index}.taxes`, [...taxes, { code, rate: r }], { shouldDirty: true });
      setRate("5");
    }
  };

  const removeTax = (i: number) => {
    setValue(
      `lineItems.${index}.taxes`,
      taxes.filter((_, j) => j !== i),
      { shouldDirty: true },
    );
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="h-8 w-full rounded-md border border-border bg-surface px-2 text-left text-xs hover:border-primary"
        >
          {totalPct > 0 ? `${totalPct}%` : <span className="text-foreground-subtle">—</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-60 space-y-2 p-3">
        {taxes.length > 0 && (
          <div className="space-y-1">
            {taxes.map((t, i) => (
              <div key={i} className="flex items-center justify-between text-xs">
                <span className="font-medium">{t.code} {t.rate}%</span>
                <button
                  type="button"
                  onClick={() => removeTax(i)}
                  className="rounded p-0.5 text-foreground-subtle hover:text-danger"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
            <div className="border-t border-border pt-1" />
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <Select value={code} onValueChange={(v) => setCode(v as TaxCode)}>
            <SelectTrigger className="h-7 w-20 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TAX_CODES.filter((c) => c !== "NONE").map((c) => (
                <SelectItem key={c} value={c}>{c}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            className="h-7 w-16 text-xs"
            type="number"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            placeholder="%"
          />
          <Button type="button" size="sm" className="h-7 px-2 text-xs" onClick={add}>
            Add
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ── Live computed amounts ─────────────────────────────────────────────────────

function LineAmount({
  control,
  index,
  currency,
  taxInclusive,
}: {
  control: Control<FormValues>;
  index: number;
  currency: string;
  taxInclusive: boolean;
}) {
  const line = useWatch({ control, name: `lineItems.${index}` });
  const b = computeInvoiceLine({
    quantity: Number(line?.quantity) || 0,
    unitPriceMinor: toMinor(line?.unitPrice ?? 0),
    discountPct: Number(line?.discountPct) || 0,
    taxes: (line?.taxes ?? []).map((t) => ({ code: t.code, rate: Number(t.rate) || 0 })),
    taxInclusive,
  });
  return <span className="font-numeric text-sm">{formatMoney(b.lineTotalMinor, currency)}</span>;
}

function Totals({ control, currency, taxInclusive }: { control: Control<FormValues>; currency: string; taxInclusive: boolean }) {
  const lines = useWatch({ control, name: "lineItems" }) ?? [];
  const totals = sumInvoiceTotals(
    lines.map((l) => ({
      quantity: Number(l?.quantity) || 0,
      unitPriceMinor: toMinor(l?.unitPrice ?? 0),
      discountPct: Number(l?.discountPct) || 0,
      taxes: (l?.taxes ?? []).map((t) => ({ code: t.code, rate: Number(t.rate) || 0 })),
      taxInclusive,
    })),
  );

  const Row = ({ label, value, strong }: { label: string; value: number; strong?: boolean }) => (
    <div className={`flex justify-between gap-8 ${strong ? "border-t border-border pt-2 text-base font-semibold" : "text-sm text-foreground-muted"}`}>
      <span>{label}</span>
      <motion.span
        key={value}
        initial={{ opacity: 0.4 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.2 }}
        className="font-numeric text-foreground"
      >
        {formatMoney(value, currency)}
      </motion.span>
    </div>
  );

  return (
    <div className="w-full max-w-xs space-y-2 rounded-lg border border-border bg-surface p-4 lg:self-start">
      <Row label="Subtotal" value={totals.subtotalMinor} />
      {totals.discountTotalMinor > 0 && <Row label="Discount" value={totals.discountTotalMinor} />}
      {totals.taxBreakdown.map((t) => (
        <Row key={t.code} label={`Tax (${t.code})`} value={t.amountMinor} />
      ))}
      <Row label="Total" value={totals.totalMinor} strong />
    </div>
  );
}

