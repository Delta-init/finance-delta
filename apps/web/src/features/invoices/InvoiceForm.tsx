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
  RECURRING_FREQUENCIES,
  computeInvoiceLine,
  sumInvoiceTotals,
  toMinor,
  formatMoney,
  type CreateInvoiceInput,
  type Invoice,
  type TaxCode,
  type TaxConfigItem,
} from "@delta/shared";
import { ProductSearchInput } from "@/features/inventory/ProductSearchInput";
import { SuggestInput } from "@/components/ui/suggest-input";
import { TotalRow } from "@/components/ui/total-row";
import { CurrencyRateFields } from "@/components/ui/currency-rate-fields";
import { useRecentSuggestion } from "@/features/suggestions/api";
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
import { QuickCreateSalespersonModal } from "@/features/users/QuickCreateSalespersonModal";
import { useUsers } from "@/features/users/api";
import { useTaxConfig, useOrganization } from "@/features/organization/api";
import { useCurrency } from "@/lib/currency-context";
import { useCan } from "@/lib/use-can";
import { useSession } from "next-auth/react";

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
  hsnSac: z.string().optional().default(""),
  itemId: z.string().optional(),
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
  currency: z.string().min(3).max(3),
  exchangeRate: z.string().optional(),
});

type FormValues = z.infer<typeof formSchema>;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * The line-item columns. HSN/SAC belongs on an Indian tax invoice and nowhere
 * else, so the column exists only where the organization's tax system asks for
 * it rather than sitting empty on every dirham invoice.
 */
const GRID = "28px minmax(160px,1fr) 70px 120px 64px 80px 100px 36px";
const GRID_HSN = "28px minmax(160px,1fr) 90px 70px 120px 64px 80px 100px 36px";
const today = () => new Date().toISOString().slice(0, 10);
const inDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const emptyLine = (taxes: { code: string; rate: number }[] = [], hsnSac = "") => ({
  description: "", quantity: 1, unitPrice: 0, discountPct: 0, taxes, hsnSac,
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
      hsnSac: l.hsnSac ?? "",
      itemId: l.itemId,
    })),
    hasProgress: !!inv.progress,
    progress: inv.progress ?? undefined,
    hasRecurring: !!inv.recurring,
    taxInclusive: inv.taxInclusive ?? false,
    currency: inv.currency,
    exchangeRate: inv.exchangeRate ? String(inv.exchangeRate) : "",
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
    // Sent explicitly. It used to be left out, so the server fell back to the
    // customer's currency while the form displayed the header's display toggle
    // — two different answers to what currency the invoice was in.
    currency: v.currency,
    exchangeRate: v.exchangeRate ? Number(v.exchangeRate) : undefined,
    lineItems: v.lineItems.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unitPriceMinor: toMinor(l.unitPrice),
      discountPct: l.discountPct,
      taxes: l.taxes,
      hsnSac: l.hsnSac ?? "",
      itemId: l.itemId || undefined,
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
  const { baseCurrency, rateBetween, ratesDate } = useCurrency();
  const isINROrg = baseCurrency === "INR";
  const { data: customers } = useCustomers({ pageSize: 100, sort: "name", dir: "asc" });
  // Somebody raising their own invoices has one salesperson available —
  // themselves — and cannot read the user list to populate a picker. The
  // server pins it to them regardless, so the field is filled in rather than
  // asked about, and the value below only has to satisfy the form.
  const { ownOnly } = useCan();
  const { data: session } = useSession();
  const mineOnly = ownOnly("invoice:read", "invoice:read:own");

  const { data: users } = useUsers(
    { pageSize: 100, sort: "name", dir: "asc" },
    { enabled: !mineOnly },
  );
  const { data: taxConfig } = useTaxConfig();
  const { data: org } = useOrganization();
  // HSN/SAC is an Indian requirement; showing the column anywhere else is a box
  // nobody can fill in. The organization's default drops into every new line.
  const showHsn = (taxConfig?.taxSystem ?? org?.taxSystem) === "gst";
  const defaultHsnSac = org?.invoiceDefaults?.hsnSac ?? "";
  const lineGrid = showHsn ? GRID_HSN : GRID;
  const [error, setError] = useState<string | null>(null);
  const [customerModalOpen, setCustomerModalOpen] = useState(false);
  const [salespersonModalOpen, setSalespersonModalOpen] = useState(false);

  // The field is hidden for somebody raising their own invoices, but the form
  // still validates it. Filled with themselves, which is what the server pins
  // it to anyway — so the value the form carries and the value that gets
  // stored are the same thing rather than two answers that happen to agree.
  useEffect(() => {
    if (mineOnly && session?.user?.id && !watch("salespersonId")) {
      setValue("salespersonId", session.user.id, { shouldValidate: true });
    }
  }, [mineOnly, session?.user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

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
          // Filled from the organization once the session has loaded.
          currency: "",
          exchangeRate: "",
        },
  });

  const { fields, append, remove, move } = useFieldArray({ control, name: "lineItems" });

  // A new invoice starts in the organization's own currency. Only once — after
  // that it is whatever was chosen on the invoice.
  const currencySeeded = useRef(false);
  useEffect(() => {
    if (initial || currencySeeded.current || !baseCurrency) return;
    currencySeeded.current = true;
    setValue("currency", baseCurrency);
  }, [baseCurrency, initial, setValue]);

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

  // Pre-fill Notes & Terms with the last-used values on a brand-new invoice
  // (so repeated boilerplate carries over). Applied once; editing untouched.
  const isNew = !initial;
  const { data: recentNotes } = useRecentSuggestion("notes", "invoice", isNew);
  const { data: recentTerms } = useRecentSuggestion("terms", "invoice", isNew);
  // Terms the organization has set in Settings win over the last-used ones:
  // one is a decision somebody made on purpose, the other is a guess from
  // history, and a guess should not quietly overrule a setting.
  const defaultTerms = org?.invoiceDefaults?.terms ?? "";
  const appliedRecentText = useRef(false);
  useEffect(() => {
    if (!isNew || appliedRecentText.current) return;
    if (recentNotes === undefined && recentTerms === undefined && org === undefined) return;
    appliedRecentText.current = true;
    if (recentNotes && !getValues("notes")) setValue("notes", recentNotes);
    const terms = defaultTerms || recentTerms;
    if (terms && !getValues("terms")) setValue("terms", terms);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recentNotes, recentTerms, defaultTerms, org, isNew]);

  /*
   * The invoice's own currency, chosen on the invoice.
   *
   * Not the header's display toggle, which is a preference about how figures
   * are shown and has no business deciding what a client is billed in.
   */
  const currency = watch("currency") || baseCurrency || "AED";
  const rate = watch("exchangeRate") ?? "";
  const rateTouched = useRef(false);
  // What the invoice comes to as it stands, so the conversion beside the rate
  // moves while the line items are being typed.
  const watchedLines = watch("lineItems");
  const totalMinorForFx = (watchedLines ?? []).reduce((sum, l) => {
    const qty = Number(l?.quantity) || 0;
    const unit = toMinor(l?.unitPrice ?? 0);
    const gross = Math.round(qty * unit);
    const disc = Math.round((gross * (Number(l?.discountPct) || 0)) / 100);
    return sum + gross - disc;
  }, 0);

  useEffect(() => {
    if (rateTouched.current) return;
    const fetched = rateBetween(baseCurrency || "AED", currency);
    setValue("exchangeRate", fetched === null ? "" : String(fetched));
  }, [baseCurrency, currency, rateBetween, setValue]);
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
                <Select key={field.value} value={field.value} onValueChange={field.onChange}>
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

          {!mineOnly && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label>Salesperson *</Label>
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
                  <Select key={field.value} value={field.value} onValueChange={field.onChange}>
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
          )}

          <CurrencyRateFields
            currency={currency}
            onCurrencyChange={(c) => { rateTouched.current = false; setValue("currency", c, { shouldDirty: true }); }}
            baseCurrency={baseCurrency || "AED"}
            rate={rate}
            onRateChange={(r) => { rateTouched.current = true; setValue("exchangeRate", r, { shouldDirty: true }); }}
            ratesDate={ratesDate}
            amountMinor={totalMinorForFx}
          />

          <div className="space-y-1.5">
            <Label>Reference / PO#</Label>
            <SuggestInput
              field="reference"
              value={watch("reference") ?? ""}
              onChange={(v) => setValue("reference", v, { shouldDirty: true })}
              placeholder="e.g. PO-1234"
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
            <div className={showHsn ? "min-w-[810px]" : "min-w-[720px]"}>
              <div
                className="grid items-center gap-2 border-b border-border bg-surface-muted px-3 py-2 text-xs font-medium uppercase tracking-wide text-foreground-subtle"
                style={{ gridTemplateColumns: lineGrid }}
              >
                <span />
                <span>Description</span>
                {showHsn && <span>HSN/SAC</span>}
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
                    showHsn={showHsn}
                    gridTemplate={lineGrid}
                    canRemove={fields.length > 1}
                    onRemove={() => remove(i)}
                  />
                ))}
              </Reorder.Group>
            </div>
          </div>
          {errors.lineItems && <p className="text-xs text-danger">{errors.lineItems.message}</p>}
          <Button type="button" variant="outline" size="sm" onClick={() => append(emptyLine(defaultTaxes, defaultHsnSac))}>
            <Plus className="h-4 w-4" /> Add line
          </Button>
        </FadeIn>

        {/* Notes / Terms / Totals */}
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
  configuredRates,
  currency,
  taxInclusive,
  showHsn,
  gridTemplate,
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
  showHsn: boolean;
  gridTemplate: string;
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
      style={{ gridTemplateColumns: gridTemplate }}
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
      <ProductCell index={index} register={register} control={control} setValue={setValue} currency={currency} />
      {showHsn && (
        <Input className="h-8" placeholder="9992" {...register(`lineItems.${index}.hsnSac`)} />
      )}
      <Input className="h-8" type="number" step="any" {...register(`lineItems.${index}.quantity`)} />
      <Input className="h-8" type="number" step="0.01" {...register(`lineItems.${index}.unitPrice`)} />
      <Input className="h-8" type="number" step="any" {...register(`lineItems.${index}.discountPct`)} />
      <TaxCell control={control} index={index} setValue={setValue} configuredRates={configuredRates} />
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

// ── Product autocomplete cell ─────────────────────────────────────────────────
// Type freely for a custom product, or pick a catalog item to auto-fill the
// price (and link the line to the item for stock deduction).

function ProductCell({
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
        {quickRates.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {quickRates.map((r) => (
              <button
                key={r.code}
                type="button"
                onClick={() => setValue(`lineItems.${index}.taxes`, [...taxes, { code: r.code, rate: r.rate }], { shouldDirty: true })}
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


  return (
    <div className="w-full max-w-xs space-y-2 rounded-lg border border-border bg-surface p-4 lg:self-start">
      <TotalRow label="Subtotal" value={totals.subtotalMinor} currency={currency} />
      {totals.discountTotalMinor > 0 && <TotalRow label="Discount" value={totals.discountTotalMinor} currency={currency} />}
      {totals.taxBreakdown.map((t) => (
        <TotalRow key={t.code} label={`Tax (${t.code})`} value={t.amountMinor} currency={currency} />
      ))}
      <TotalRow label="Total" value={totals.totalMinor} currency={currency} strong />
    </div>
  );
}

