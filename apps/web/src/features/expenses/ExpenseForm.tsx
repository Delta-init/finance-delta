"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ArrowLeft, Plus, Trash2, Paperclip, RefreshCw, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useCreateExpense, useUpdateExpense } from "@/features/expenses/api";
import { useExpenseCategories } from "@/features/expense-categories/api";
import { computeExpenseTax, formatMoney, toMinor, type CreateExpenseInput } from "@delta/shared";
import { useCurrency } from "@/lib/currency-context";

const PAYMENT_METHODS = [
  { value: "bank_transfer", label: "Bank Transfer" },
  { value: "cash", label: "Cash" },
  { value: "cheque", label: "Cheque" },
  { value: "card", label: "Card" },
  { value: "online", label: "Online" },
] as const;

const FREQUENCIES = [
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "yearly", label: "Yearly" },
] as const;

const formSchema = z.object({
  category: z.string().min(1, "Category is required"),
  description: z.string().min(1, "Description is required"),
  expenseDate: z.string().min(1, "Expense date is required"),
  amountDisplay: z.string().min(1, "Amount is required"),
  currency: z.string().default("AED"),
  categoryOther: z.string().max(60).optional().default(""),
  taxPct: z.coerce.number().min(0).max(100).default(0),
  taxInclusive: z.boolean().default(false),
  paymentAccount: z.string().optional(),
  paymentMethod: z.enum(["bank_transfer", "cash", "cheque", "card", "online"]).optional(),
  reference: z.string().optional(),
  requiresApproval: z.boolean().default(false),
  isRecurring: z.boolean().default(false),
  recurrenceFrequency: z.enum(["weekly", "monthly", "quarterly", "yearly"]).optional(),
  recurrenceNextDate: z.string().optional(),
  recurrenceEndDate: z.string().optional(),
  hasMileage: z.boolean().default(false),
  mileageDistanceKm: z.coerce.number().optional(),
  mileageRateDisplay: z.string().optional(),
  projectName: z.string().optional(),
  costCentre: z.string().optional(),
  notes: z.string().optional(),
  attachments: z.array(z.object({ name: z.string(), url: z.string() })).default([]),
});
export type ExpenseFormValues = z.infer<typeof formSchema>;

interface ExpenseFormProps {
  mode: "create" | "edit";
  expenseId?: string;
  initialValues?: Partial<ExpenseFormValues>;
}

export function ExpenseForm({ mode, expenseId, initialValues }: ExpenseFormProps) {
  const router = useRouter();
  const createExpense = useCreateExpense();
  const updateExpense = useUpdateExpense(expenseId ?? "");
  const { data: categoryList } = useExpenseCategories();
  const { currency: orgCurrency } = useCurrency();
  const today = new Date().toISOString().slice(0, 10);
  const isEdit = mode === "edit";

  const { register, handleSubmit, watch, setValue, control, formState: { errors, isSubmitting } } =
    useForm<ExpenseFormValues>({
      resolver: zodResolver(formSchema),
      defaultValues: {
        category: "other",
        expenseDate: today,
        currency: orgCurrency,
        categoryOther: "",
        taxPct: 0,
        taxInclusive: false,
        requiresApproval: false,
        isRecurring: false,
        hasMileage: false,
        attachments: [],
        ...initialValues,
      },
    });

  const { fields: attachmentFields, append: addAttachment, remove: removeAttachment } =
    useFieldArray({ control, name: "attachments" });

  useEffect(() => {
    // In create mode, follow the org's display currency. In edit mode, keep the saved currency.
    if (!isEdit) setValue("currency", orgCurrency, { shouldDirty: false });
  }, [orgCurrency, isEdit]); // eslint-disable-line react-hooks/exhaustive-deps

  const currency = watch("currency");
  // Shown back as it is entered, so nobody has to work out whether the figure
  // they typed was the one on the receipt.
  const taxInclusive = watch("taxInclusive");
  const preview = computeExpenseTax(
    toMinor(watch("amountDisplay") || "0"),
    Number(watch("taxPct")) || 0,
    taxInclusive,
  );
  const [catWatch, isRecurring, hasMileage] = [
    watch("category"),
    watch("isRecurring"),
    watch("hasMileage"),
  ];

  async function onSubmit(values: ExpenseFormValues) {
    const input: CreateExpenseInput = {
      category: values.category,
      description: values.description,
      expenseDate: values.expenseDate,
      amountMinor: toMinor(values.amountDisplay),
      currency: values.currency,
      categoryOther: values.categoryOther ?? "",
      taxPct: values.taxPct ?? 0,
      taxInclusive: values.taxInclusive ?? false,
      paymentAccount: values.paymentAccount ?? "",
      paymentMethod: values.paymentMethod,
      reference: values.reference ?? "",
      requiresApproval: values.requiresApproval,
      isRecurring: values.isRecurring,
      recurrence:
        values.isRecurring && values.recurrenceFrequency && values.recurrenceNextDate
          ? {
              frequency: values.recurrenceFrequency,
              nextDate: values.recurrenceNextDate,
              endDate: values.recurrenceEndDate || undefined,
              isActive: true,
            }
          : undefined,
      mileage:
        values.hasMileage && values.mileageDistanceKm && values.mileageRateDisplay
          ? {
              distanceKm: values.mileageDistanceKm,
              ratePerKmMinor: toMinor(values.mileageRateDisplay),
            }
          : undefined,
      attachments: values.attachments ?? [],
      projectName: values.projectName ?? "",
      costCentre: values.costCentre ?? "",
      notes: values.notes ?? "",
    };

    try {
      if (isEdit && expenseId) {
        await updateExpense.mutateAsync(input);
        toast.success("Expense updated");
        router.push(`/expenses/${expenseId}`);
      } else {
        const expense = await createExpense.mutateAsync(input);
        toast.success("Expense created");
        router.push(`/expenses/${expense.id}`);
      }
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : `Failed to ${isEdit ? "update" : "create"} expense`);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Link href={isEdit && expenseId ? `/expenses/${expenseId}` : "/expenses"} className="rounded-md p-1.5 text-foreground-muted hover:bg-surface-muted">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <h1 className="text-xl font-semibold">{isEdit ? "Edit Expense" : "New Expense"}</h1>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        {/* Core Details */}
        <div className="rounded-lg border border-border bg-surface p-5 space-y-4">
          <h2 className="text-sm font-semibold">Expense Details</h2>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Category *</Label>
              <Select
                value={watch("category")}
                onValueChange={(v) => setValue("category", v)}
              >
                <SelectTrigger><SelectValue placeholder="Select category" /></SelectTrigger>
                <SelectContent>
                  {(categoryList ?? []).map((c) => (
                    <SelectItem key={c.slug} value={c.slug}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.category && <p className="text-xs text-danger">{errors.category.message}</p>}
              {/* "Other" is the escape hatch for a spend nothing else describes,
                  and one nobody can name just produces a column of claims all
                  saying "Other". Reports still group on the category, so naming
                  one does not split them up. */}
              {catWatch === "other" && (
                <div className="space-y-1.5 pt-1">
                  <Label>Name it</Label>
                  <Input
                    {...register("categoryOther")}
                    placeholder="e.g. Office plants"
                    maxLength={60}
                  />
                  <p className="text-xs text-foreground-muted">
                    Optional. Shown instead of &ldquo;Other&rdquo; on this claim.
                  </p>
                </div>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>Expense Date *</Label>
              <Input type="date" {...register("expenseDate")} />
              {errors.expenseDate && <p className="text-xs text-danger">{errors.expenseDate.message}</p>}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Description *</Label>
            <Input {...register("description")} placeholder="What was this expense for?" />
            {errors.description && <p className="text-xs text-danger">{errors.description.message}</p>}
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label>Amount *</Label>
              <Input
                type="number"
                step="0.01"
                placeholder="0.00"
                {...register("amountDisplay")}
              />
              {errors.amountDisplay && <p className="text-xs text-danger">{errors.amountDisplay.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label>Currency</Label>
              <Select key={currency} value={currency} onValueChange={(v) => setValue("currency", v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["AED", "USD", "EUR", "GBP", "INR", "SAR"].map((c) => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Tax %</Label>
              <Input type="number" step="0.01" placeholder="0" {...register("taxPct")} />
              {errors.taxPct && <p className="text-xs text-danger">{errors.taxPct.message}</p>}
            </div>
          </div>

          {/* A receipt shows one number, and whether it already contains the tax
              depends on the receipt. Asking is the only way to know. */}
          <label className="flex items-start gap-2.5">
            <input
              type="checkbox"
              {...register("taxInclusive")}
              className="mt-0.5 h-4 w-4 accent-[var(--primary)]"
            />
            <span>
              <span className="block text-sm font-medium">Amount already includes tax</span>
              <span className="block text-xs text-foreground-muted">
                Tick this when the figure on the receipt is the total paid.
              </span>
            </span>
          </label>

          {preview.taxMinor > 0 && (
            <div className="flex flex-wrap gap-x-6 gap-y-1 rounded-md border border-border bg-surface-muted px-3 py-2 text-xs">
              <span className="text-foreground-muted">
                Net <span className="font-numeric font-medium text-foreground">{formatMoney(preview.netMinor, currency)}</span>
              </span>
              <span className="text-foreground-muted">
                Tax <span className="font-numeric font-medium text-foreground">{formatMoney(preview.taxMinor, currency)}</span>
              </span>
              <span className="text-foreground-muted">
                Total <span className="font-numeric font-semibold text-foreground">{formatMoney(preview.totalMinor, currency)}</span>
              </span>
            </div>
          )}
        </div>

        {/* Mileage (travel only) */}
        {catWatch === "travel" && (
          <div className="rounded-lg border border-border bg-surface p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <MapPin className="h-4 w-4 text-foreground-muted" />
                <h2 className="text-sm font-semibold">Mileage Tracking</h2>
              </div>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-border"
                  checked={hasMileage}
                  onChange={(e) => setValue("hasMileage", e.target.checked)}
                />
                Enable mileage calculation
              </label>
            </div>
            {hasMileage && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>Distance (km) *</Label>
                  <Input type="number" step="0.1" placeholder="0.0" {...register("mileageDistanceKm")} />
                </div>
                <div className="space-y-1.5">
                  <Label>Rate per km ({watch("currency")})</Label>
                  <Input type="number" step="0.001" placeholder="0.000" {...register("mileageRateDisplay")} />
                  <p className="text-xs text-foreground-muted">Mileage total will be recorded alongside the main amount</p>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Payment Info */}
        <div className="rounded-lg border border-border bg-surface p-5 space-y-4">
          <h2 className="text-sm font-semibold">Payment Information</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Payment Method</Label>
              <Select
                value={watch("paymentMethod") ?? ""}
                onValueChange={(v) => setValue("paymentMethod", v as ExpenseFormValues["paymentMethod"])}
              >
                <SelectTrigger><SelectValue placeholder="Select method" /></SelectTrigger>
                <SelectContent>
                  {PAYMENT_METHODS.map((m) => (
                    <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Payment Account / Bank</Label>
              <Input {...register("paymentAccount")} placeholder="e.g. Main current account" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Reference</Label>
            <Input {...register("reference")} placeholder="Receipt #, invoice #, etc." />
          </div>
        </div>

        {/* Project / Cost Centre */}
        <div className="rounded-lg border border-border bg-surface p-5 space-y-4">
          <h2 className="text-sm font-semibold">Project & Cost Centre</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Project Name</Label>
              <Input {...register("projectName")} placeholder="e.g. Website Redesign" />
            </div>
            <div className="space-y-1.5">
              <Label>Cost Centre</Label>
              <Input {...register("costCentre")} placeholder="e.g. Marketing, Engineering" />
            </div>
          </div>
        </div>

        {/* Recurring */}
        <div className="rounded-lg border border-border bg-surface p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <RefreshCw className="h-4 w-4 text-foreground-muted" />
              <h2 className="text-sm font-semibold">Recurring Expense</h2>
            </div>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-border"
                checked={isRecurring}
                onChange={(e) => setValue("isRecurring", e.target.checked)}
              />
              This expense recurs
            </label>
          </div>
          {isRecurring && (
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label>Frequency *</Label>
                <Select
                  value={watch("recurrenceFrequency") ?? ""}
                  onValueChange={(v) => setValue("recurrenceFrequency", v as ExpenseFormValues["recurrenceFrequency"])}
                >
                  <SelectTrigger><SelectValue placeholder="Select frequency" /></SelectTrigger>
                  <SelectContent>
                    {FREQUENCIES.map((f) => (
                      <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Next Occurrence *</Label>
                <Input type="date" {...register("recurrenceNextDate")} />
              </div>
              <div className="space-y-1.5">
                <Label>End Date</Label>
                <Input type="date" {...register("recurrenceEndDate")} />
                <p className="text-xs text-foreground-muted">Leave blank for indefinite</p>
              </div>
            </div>
          )}
        </div>

        {/* Attachments */}
        <div className="rounded-lg border border-border bg-surface p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Paperclip className="h-4 w-4 text-foreground-muted" />
              <h2 className="text-sm font-semibold">Supporting Documents</h2>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => addAttachment({ name: "", url: "" })}
            >
              <Plus className="h-3.5 w-3.5" /> Add document
            </Button>
          </div>
          {attachmentFields.length === 0 ? (
            <p className="text-sm text-foreground-muted">No attachments added. Click "Add document" to attach a receipt or supporting file.</p>
          ) : (
            <div className="space-y-2">
              {attachmentFields.map((field, i) => (
                <div key={field.id} className="grid grid-cols-[1fr_1.5fr_auto] gap-2 items-center">
                  <Input
                    {...register(`attachments.${i}.name`)}
                    placeholder="Document name"
                  />
                  <Input
                    {...register(`attachments.${i}.url`)}
                    placeholder="https://... or file path"
                  />
                  <Button type="button" variant="ghost" size="sm" onClick={() => removeAttachment(i)}>
                    <Trash2 className="h-4 w-4 text-foreground-muted" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Notes & Approval */}
        <div className="rounded-lg border border-border bg-surface p-5 space-y-4">
          <h2 className="text-sm font-semibold">Additional Info</h2>
          <div className="space-y-1.5">
            <Label>Notes</Label>
            <textarea
              {...register("notes")}
              rows={3}
              placeholder="Any additional context or notes…"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-foreground-subtle focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 resize-none"
            />
          </div>
          {!isEdit && (
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 rounded border-border"
                {...register("requiresApproval")}
              />
              <div>
                <p className="text-sm font-medium">Requires manager approval</p>
                <p className="text-xs text-foreground-muted">Expense will be submitted for review before being recorded</p>
              </div>
            </label>
          )}
        </div>

        <div className="flex justify-end gap-3">
          <Button type="button" variant="outline" onClick={() => router.push(isEdit && expenseId ? `/expenses/${expenseId}` : "/expenses")}>Cancel</Button>
          <Button type="submit" loading={isSubmitting}>{isEdit ? "Save Changes" : "Create Expense"}</Button>
        </div>
      </form>
    </div>
  );
}
