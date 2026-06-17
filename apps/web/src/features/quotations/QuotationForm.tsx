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
} from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Reorder, useDragControls, motion } from "framer-motion";
import { Trash2, Plus, GripVertical, ArrowLeft } from "lucide-react";
import {
  computeLine,
  sumTotals,
  toMinor,
  formatMoney,
  type CreateQuotationInput,
  type Quotation,
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
import { FadeIn } from "@/components/ui/motion";
import { TagPicker } from "@/features/tags/TagPicker";
import { useCustomers } from "@/features/customers/api";

const lineSchema = z.object({
  description: z.string().min(1, "Required"),
  quantity: z.coerce.number().positive(),
  unitPrice: z.coerce.number().min(0),
  discountPct: z.coerce.number().min(0).max(100),
  taxPct: z.coerce.number().min(0).max(100),
});
const formSchema = z.object({
  customerId: z.string().min(1, "Select a customer"),
  issueDate: z.string().min(1, "Required"),
  expiryDate: z.string().min(1, "Required"),
  notes: z.string().optional(),
  terms: z.string().optional(),
  tagIds: z.array(z.string()).optional().default([]),
  lineItems: z.array(lineSchema).min(1, "Add at least one line"),
});
type FormValues = z.infer<typeof formSchema>;

const GRID = "28px minmax(160px,1fr) 72px 116px 72px 72px 104px 36px";
const today = () => new Date().toISOString().slice(0, 10);
const inDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const emptyLine = { description: "", quantity: 1, unitPrice: 0, discountPct: 0, taxPct: 0 };

function fromQuotation(q: Quotation): FormValues {
  return {
    customerId: q.customerId,
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
      taxPct: l.taxPct,
    })),
  };
}
function toApiInput(v: FormValues): CreateQuotationInput {
  return {
    customerId: v.customerId,
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
      taxPct: l.taxPct,
    })),
  };
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
  const { data: customers } = useCustomers({ pageSize: 100, sort: "name", dir: "asc" });
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: initial
      ? fromQuotation(initial)
      : {
          customerId: "",
          issueDate: today(),
          expiryDate: inDays(14),
          notes: "",
          terms: "",
          tagIds: [],
          lineItems: [{ ...emptyLine }],
        },
  });

  const { fields, append, remove, move } = useFieldArray({ control, name: "lineItems" });
  const currency = initial?.currency ?? "AED";

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
        <FadeIn className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1.5">
            <Label>Customer</Label>
            <Controller
              control={control}
              name="customerId"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
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
                <span>Tax %</span>
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
                    currency={currency}
                    canRemove={fields.length > 1}
                    onRemove={() => remove(i)}
                  />
                ))}
              </Reorder.Group>
            </div>
          </div>
          {errors.lineItems && <p className="text-xs text-danger">{errors.lineItems.message}</p>}
          <Button type="button" variant="outline" size="sm" onClick={() => append({ ...emptyLine })}>
            <Plus className="h-4 w-4" /> Add line
          </Button>
        </FadeIn>

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
          </div>
          <Totals control={control} currency={currency} />
        </FadeIn>

        {error && <p className="text-sm text-danger">{error}</p>}
      </div>
    </form>
  );
}

function LineRow({
  value,
  index,
  register,
  control,
  currency,
  canRemove,
  onRemove,
}: {
  value: { id: string };
  index: number;
  register: UseFormRegister<FormValues>;
  control: Control<FormValues>;
  currency: string;
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
      <Input className="h-8" type="number" step="any" {...register(`lineItems.${index}.taxPct`)} />
      <div className="text-right">
        <LineAmount control={control} index={index} currency={currency} />
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

function LineAmount({
  control,
  index,
  currency,
}: {
  control: Control<FormValues>;
  index: number;
  currency: string;
}) {
  const line = useWatch({ control, name: `lineItems.${index}` });
  const b = computeLine({
    quantity: Number(line?.quantity) || 0,
    unitPriceMinor: toMinor(line?.unitPrice ?? 0),
    discountPct: Number(line?.discountPct) || 0,
    taxPct: Number(line?.taxPct) || 0,
  });
  return <span className="font-numeric text-sm">{formatMoney(b.lineTotalMinor, currency)}</span>;
}

function Totals({ control, currency }: { control: Control<FormValues>; currency: string }) {
  const lines = useWatch({ control, name: "lineItems" }) ?? [];
  const totals = sumTotals(
    lines.map((l) => ({
      quantity: Number(l?.quantity) || 0,
      unitPriceMinor: toMinor(l?.unitPrice ?? 0),
      discountPct: Number(l?.discountPct) || 0,
      taxPct: Number(l?.taxPct) || 0,
    })),
  );
  const Row = ({ label, value, strong }: { label: string; value: number; strong?: boolean }) => (
    <div
      className={`flex justify-between gap-8 ${
        strong ? "border-t border-border pt-2 text-base font-semibold" : "text-sm text-foreground-muted"
      }`}
    >
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
      <Row label="Discount" value={totals.discountTotalMinor} />
      <Row label="Tax" value={totals.taxTotalMinor} />
      <Row label="Total" value={totals.totalMinor} strong />
    </div>
  );
}
