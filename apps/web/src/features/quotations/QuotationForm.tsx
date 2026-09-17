"use client";

import { useEffect, useRef, useState } from "react";
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
import { Reorder, useDragControls } from "framer-motion";
import { Trash2, Plus, GripVertical, ArrowLeft, X } from "lucide-react";
import {
  TAX_CODES,
  TAX_SYSTEM_PRESETS,
  computeInvoiceLine,
  sumInvoiceTotals,
  toMinor,
  formatMoney,
  type CreateQuotationInput,
  type Quotation,
  type TaxCode,
  type TaxConfigItem,
} from "@delta/shared";
import { Button } from "@/components/ui/button";
import { TotalRow } from "@/components/ui/total-row";
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
import { ProductSearchInput } from "@/features/inventory/ProductSearchInput";
import { SuggestInput } from "@/components/ui/suggest-input";
import { useRecentSuggestion } from "@/features/suggestions/api";
import { useCustomers } from "@/features/customers/api";
import { QuickCreateCustomerModal } from "@/features/customers/QuickCreateCustomerModal";
import { QuickCreateSalespersonModal } from "@/features/users/QuickCreateSalespersonModal";
import { useUsers } from "@/features/users/api";
import { useTaxConfig } from "@/features/organization/api";
import { useCurrency } from "@/lib/currency-context";

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
  itemId: z.string().optional(),
});
const formSchema = z.object({
  customerId: z.string().min(1, "Select a customer"),
  salespersonId: z.string().optional(),
  issueDate: z.string().min(1, "Required"),
  expiryDate: z.string().min(1, "Required"),
  notes: z.string().optional(),
  terms: z.string().optional(),
  tagIds: z.array(z.string()).optional().default([]),
  lineItems: z.array(lineSchema).min(1, "Add at least one line"),
  taxInclusive: z.boolean().default(false),
});
type FormValues = z.infer<typeof formSchema>;

const GRID = "28px minmax(160px,1fr) 72px 116px 72px 80px 104px 36px";
const today = () => new Date().toISOString().slice(0, 10);
const inDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const emptyLine = (taxes: { code: string; rate: number }[] = []) => ({
  description: "", quantity: 1, unitPrice: 0, discountPct: 0, taxes,
});

function fromQuotation(q: Quotation): FormValues {
  return {
    customerId: q.customerId,
    salespersonId: undefined,
    issueDate: q.issueDate,
    expiryDate: q.expiryDate,
    notes: q.notes,
    terms: q.terms,
    tagIds: q.tags.map((tg) => tg.id),
    lineItems: q.lineItems.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPriceMinor / 100,
      discountPct: l.discountPct,
      taxes: l.taxes?.length
        ? l.taxes.map((t) => ({ code: t.code, rate: t.rate }))
        : l.taxPct > 0
          ? [{ code: "VAT", rate: l.taxPct }]
          : [],
      itemId: l.itemId,
    })),
    taxInclusive: q.taxInclusive ?? false,
  };
}
function toApiInput(v: FormValues): CreateQuotationInput {
  return {
    customerId: v.customerId,
    salespersonId: v.salespersonId || undefined,
    issueDate: v.issueDate,
    expiryDate: v.expiryDate,
    notes: v.notes ?? "",
    terms: v.terms ?? "",
    tagIds: v.tagIds ?? [],
    lineItems: v.lineItems.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unitPriceMinor: toMinor(l.unitPrice),
      discountPct: l.discountPct,
      taxPct: 0,
      taxes: l.taxes,
      itemId: l.itemId || undefined,
    })),
    taxInclusive: v.taxInclusive ?? false,
  } as CreateQuotationInput;
}

export function QuotationForm({
  initial,
  title,
  submitLabel,
  onSubmit,
}: {
  initial?: Quotation;
  title: string;
  submitLabel: string;
  onSubmit: (input: CreateQuotationInput) => Promise<void>;
}) {
  const router = useRouter();
  const { baseCurrency } = useCurrency();
  const isINROrg = baseCurrency === "INR";
  const { data: customers } = useCustomers({ pageSize: 100, sort: "name", dir: "asc" });
  const { data: users } = useUsers({ pageSize: 100, sort: "name", dir: "asc" });
  const { data: taxConfig } = useTaxConfig();
  const [error, setError] = useState<string | null>(null);
  const [customerModalOpen, setCustomerModalOpen] = useState(false);
  const [salespersonModalOpen, setSalespersonModalOpen] = useState(false);

  // Org-configured rates; INR orgs additionally fall back to the tax-system
  // presets when none are applied yet (GST org → CGST/SGST/IGST).
  const effectiveRates: TaxConfigItem[] = taxConfig
    ? taxConfig.taxRates.length
      ? taxConfig.taxRates
      : isINROrg
        ? TAX_SYSTEM_PRESETS[taxConfig.taxSystem] ?? []
        : []
    : [];
  // All default sales-side rates apply to new lines (e.g. CGST + SGST together for GST orgs).
  const defaultTaxes = effectiveRates
    .filter((r) => r.isDefault && r.appliesTo !== "purchases")
    .map((r) => ({ code: r.code, rate: r.rate }));

  const {
    register,
    control,
    handleSubmit,
    watch,
    setValue,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: initial
      ? fromQuotation(initial)
      : {
          customerId: "",
          salespersonId: "",
          issueDate: today(),
          expiryDate: inDays(14),
          notes: "",
          terms: "",
          tagIds: [],
          lineItems: [emptyLine()],
          taxInclusive: false,
        },
  });

  const { fields, append, remove, move } = useFieldArray({ control, name: "lineItems" });
  const currency = initial?.currency ?? baseCurrency;
  const taxInclusive = watch("taxInclusive");

  // The initial line is created before the tax config loads, so apply the
  // default taxes (CGST + SGST) to untaxed lines once — INR orgs, new forms only.
  const appliedDefaultTaxes = useRef(false);
  useEffect(() => {
    if (!isINROrg || initial || appliedDefaultTaxes.current || defaultTaxes.length === 0) return;
    appliedDefaultTaxes.current = true;
    getValues("lineItems").forEach((l, i) => {
      if (!l.taxes?.length) setValue(`lineItems.${i}.taxes`, defaultTaxes);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultTaxes.length, isINROrg]);

  // Pre-fill Notes & Terms with the last-used values on a brand-new quotation.
  const isNew = !initial;
  const { data: recentNotes } = useRecentSuggestion("notes", "quotation", isNew);
  const { data: recentTerms } = useRecentSuggestion("terms", "quotation", isNew);
  const appliedRecentText = useRef(false);
  useEffect(() => {
    if (!isNew || appliedRecentText.current) return;
    if (recentNotes === undefined && recentTerms === undefined) return;
    appliedRecentText.current = true;
    if (recentNotes && !getValues("notes")) setValue("notes", recentNotes);
    if (recentTerms && !getValues("terms")) setValue("terms", recentTerms);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recentNotes, recentTerms, isNew]);

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
      setError(e instanceof Error ? e.message : "Failed to save quotation");
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
      <QuickCreateSalespersonModal
        open={salespersonModalOpen}
        onClose={() => setSalespersonModalOpen(false)}
        onCreated={(id) => {
          setValue("salespersonId", id, { shouldValidate: true });
          setSalespersonModalOpen(false);
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
          <Button type="button" variant="ghost" onClick={() => router.back()}>
            Cancel
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Saving…" : submitLabel}
          </Button>
        </div>
      </div>

      <div className="space-y-6 p-6">
        <FadeIn className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>Customer</Label>
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
                <Select key={field.value} value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a customer…" />
                  </SelectTrigger>
                  <SelectContent>
                    {customers?.data.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            {errors.customerId && <p className="text-xs text-danger">{errors.customerId.message}</p>}
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>Salesperson</Label>
              <button
                type="button"
                onClick={() => setSalespersonModalOpen(true)}
                className="text-xs text-primary hover:underline flex items-center gap-0.5"
              >
                <Plus className="h-3 w-3" /> New
              </button>
            </div>
            <Controller
              control={control}
              name="salespersonId"
              render={({ field }) => (
                <Select key={field.value} value={field.value ?? ""} onValueChange={field.onChange}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a salesperson…" />
                  </SelectTrigger>
                  <SelectContent>
                    {users?.data.map((u) => (
                      <SelectItem key={u.id} value={u.id}>
                        {u.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Issue date</Label>
            <Controller
              control={control}
              name="issueDate"
              render={({ field }) => (
                <DatePicker value={field.value} onChange={field.onChange} className="w-full" />
              )}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Expiry date</Label>
            <Controller
              control={control}
              name="expiryDate"
              render={({ field }) => (
                <DatePicker value={field.value} onChange={field.onChange} className="w-full" />
              )}
            />
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
        </FadeIn>

        {/* Line items with drag-to-reorder */}
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
            <div className="min-w-[680px]">
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
                    configuredRates={effectiveRates}
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

        <FadeIn delay={0.1} className="flex flex-col gap-6 lg:flex-row lg:justify-between">
          <div className="flex-1 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="notes">Notes</Label>
              <SuggestInput
                id="notes"
                multiline
                rows={3}
                field="notes"
                value={watch("notes") ?? ""}
                onChange={(v) => setValue("notes", v, { shouldDirty: true })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="terms">Terms</Label>
              <SuggestInput
                id="terms"
                multiline
                rows={2}
                field="terms"
                value={watch("terms") ?? ""}
                onChange={(v) => setValue("terms", v, { shouldDirty: true })}
              />
            </div>
          </div>
          <Totals control={control} currency={currency} taxInclusive={taxInclusive} />
        </FadeIn>

        {error && <p className="text-sm text-danger">{error}</p>}
      </div>
    </form>
    </>
  );
}

function LineRow({
  value,
  index,
  register,
  control,
  setValue,
  configuredRates,
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
  configuredRates: TaxConfigItem[];
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
      <QuotationProductCell index={index} register={register} control={control} setValue={setValue} currency={currency} />
      <Input className="h-8" type="number" step="any" {...register(`lineItems.${index}.quantity`)} />
      <Input className="h-8" type="number" step="0.01" {...register(`lineItems.${index}.unitPrice`)} />
      <Input className="h-8" type="number" step="any" {...register(`lineItems.${index}.discountPct`)} />
      <TaxCell control={control} index={index} setValue={setValue} configuredRates={configuredRates} />
      <div className="text-right">
        <LineAmount control={control} index={index} currency={currency} taxInclusive={taxInclusive} />
      </div>
      <div className="text-right">
        {canRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="text-foreground-subtle hover:text-danger"
            aria-label="Remove line"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>
    </Reorder.Item>
  );
}

// ── Product autocomplete cell ─────────────────────────────────────────────────

function QuotationProductCell({
  index,
  register,
  control,
  setValue,
  currency,
}: {
  index: number;
  register: UseFormRegister<FormValues>;
  control: Control<FormValues>;
  setValue: UseFormSetValue<FormValues>;
  currency: string;
}) {
  const description = useWatch({ control, name: `lineItems.${index}.description` }) ?? "";
  return (
    <ProductSearchInput
      query={description}
      registerProps={register(`lineItems.${index}.description`)}
      onType={() => setValue(`lineItems.${index}.itemId`, undefined)}
      onPick={(item) => {
        setValue(`lineItems.${index}.description`, item.name, { shouldDirty: true, shouldValidate: true });
        setValue(`lineItems.${index}.unitPrice`, item.unitPriceMinor / 100, { shouldDirty: true });
        setValue(`lineItems.${index}.itemId`, item.id, { shouldDirty: true });
      }}
      onPickText={(text) => {
        setValue(`lineItems.${index}.description`, text, { shouldDirty: true, shouldValidate: true });
        setValue(`lineItems.${index}.itemId`, undefined);
      }}
      currency={currency}
    />
  );
}

// ── Tax popover cell ──────────────────────────────────────────────────────────

function TaxCell({
  control,
  index,
  setValue,
  configuredRates,
}: {
  control: Control<FormValues>;
  index: number;
  setValue: UseFormSetValue<FormValues>;
  configuredRates: TaxConfigItem[];
}) {
  const taxes = useWatch({ control, name: `lineItems.${index}.taxes` }) ?? [];
  const [code, setCode] = useState<TaxCode>("VAT");
  const [rate, setRate] = useState("5");

  const totalPct = taxes.reduce((s, t) => s + (Number(t.rate) || 0), 0);
  const quickRates = configuredRates.filter(
    (r) => r.appliesTo !== "purchases" && !taxes.some((t) => t.code === r.code),
  );

  const addTax = (c: string, r: number) => {
    if (r > 0) {
      setValue(`lineItems.${index}.taxes`, [...taxes, { code: c, rate: r }], { shouldDirty: true });
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
        {quickRates.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {quickRates.map((r) => (
              <button
                key={r.code}
                type="button"
                onClick={() => addTax(r.code, r.rate)}
                className="rounded-full border border-border px-2 py-0.5 text-xs text-foreground-muted hover:border-primary hover:text-primary"
              >
                + {r.code} {r.rate}%
              </button>
            ))}
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
          <Button
            type="button"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => addTax(code, parseFloat(rate))}
          >
            Add
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

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
      taxInclusive,
      taxes: (l?.taxes ?? []).map((t) => ({ code: t.code, rate: Number(t.rate) || 0 })),
    })),
  );
  return (
    <div className="w-full max-w-xs space-y-2 rounded-lg border border-border bg-surface p-4 lg:self-start">
      <TotalRow label="Subtotal" value={totals.subtotalMinor} currency={currency} />
      {totals.discountTotalMinor > 0 && <TotalRow label="Discount" value={totals.discountTotalMinor} currency={currency} />}
      {totals.taxBreakdown.map((t) => (
        <TotalRow key={t.code} label={`${t.code}`} value={t.amountMinor} currency={currency} />
      ))}
      <TotalRow label="Total" value={totals.totalMinor} currency={currency} strong />
    </div>
  );
}
