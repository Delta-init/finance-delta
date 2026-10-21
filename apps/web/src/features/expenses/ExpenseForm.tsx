"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ArrowLeft, Plus, Trash2, Paperclip, RefreshCw, MapPin, Upload, FileText, Loader2, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAllDepartments } from "@/features/departments/api";
import { QuickCreateDepartmentModal } from "@/features/departments/QuickCreateDepartmentModal";
import { useCan } from "@/lib/use-can";
import { ApiError, api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useCreateExpense, useUpdateExpense } from "@/features/expenses/api";
import { useExpenseCategories } from "@/features/expense-categories/api";
import { QuickCreateCategoryModal } from "@/features/expense-categories/QuickCreateCategoryModal";
import { computeExpenseTax, formatMoney, toMinor, type CreateExpenseInput, type UploadedExpenseFile } from "@delta/shared";
import { useCurrency } from "@/lib/currency-context";
import { useOrganization } from "@/features/organization/api";
import { useBankAccounts } from "@/features/banking/api";
import { LateReasonField, useLateDate } from "@/features/late-entries/LateReason";

/** "Not in a bank account" in the account picker. */
const NO_ACCOUNT = "__none__";

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
  dueDate: z.string().optional(),
  amountDisplay: z.string().min(1, "Amount is required"),
  currency: z.string().default("AED"),
  categoryOther: z.string().max(60).optional().default(""),
  taxPct: z.coerce.number().min(0).max(100).default(0),
  taxInclusive: z.boolean().default(false),
  paymentAccount: z.string().optional(),
  /** The Banking account it is paid from — "__none__" for none (2026-10-16). */
  bankAccountId: z.string().default(NO_ACCOUNT),
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
  departmentId: z.string().optional(),
  costCentre: z.string().optional(),
  notes: z.string().optional(),
  // Uploaded files (by key); an old pasted link already on the expense keeps its url (2026-10-20).
  attachments: z.array(z.object({
    name: z.string().trim().min(1, "Name the document"),
    key: z.string().optional(),
    url: z.string().optional(),
    size: z.number().optional(),
    mimeType: z.string().optional(),
  })).default([]),
});
/** Supporting documents: the same files the receipts box on an expense takes. */
const UPLOAD_ACCEPT = "image/jpeg,image/png,image/webp,image/gif,application/pdf";
const UPLOAD_TYPES = new Set(UPLOAD_ACCEPT.split(","));
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_DOCUMENTS = 10;
function readableSize(bytes?: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export type ExpenseFormValues = z.infer<typeof formSchema>;

/** Radix reads "" as unset, so "no department" needs a value that is not it. */
const NO_DEPARTMENT = "__none__";

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
  const [categoryModalOpen, setCategoryModalOpen] = useState(false);
  const { data: departments } = useAllDepartments();
  const { can } = useCan();
  const canAddDepartment = can("department:create");
  const [deptModalOpen, setDeptModalOpen] = useState(false);
  // Shown only where a claim already carries one; there is no way to type a new
  // one, which is the point of replacing it.
  const legacyCostCentre = initialValues?.costCentre?.trim() || "";
  const { baseCurrency: orgCurrency } = useCurrency();
  const today = new Date().toISOString().slice(0, 10);
  const isEdit = mode === "edit";

  const { register, handleSubmit, watch, setValue, control, formState: { errors, isSubmitting } } =
    useForm<ExpenseFormValues>({
      resolver: zodResolver(formSchema),
      defaultValues: {
        category: "other",
        expenseDate: today,
        dueDate: "",
        currency: orgCurrency,
        categoryOther: "",
        departmentId: "",
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

  // Each picked file is stored at once (POST /expenses/uploads) and saved with the expense by its key.
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<Array<{ id: string; name: string; size: number }>>([]);
  async function onFilesPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    if (fileRef.current) fileRef.current.value = ""; // the same file can be picked again after a failure
    const room = MAX_DOCUMENTS - attachmentFields.length - uploading.length;
    if (picked.length > room) toast.error(`At most ${MAX_DOCUMENTS} documents — ${room > 0 ? `only ${room} more` : "remove one first"}`);
    for (const file of picked.slice(0, Math.max(0, room))) {
      if (!UPLOAD_TYPES.has(file.type)) { toast.error(`${file.name}: only JPG, PNG, WebP, GIF or PDF`); continue; }
      if (file.size > MAX_UPLOAD_BYTES) { toast.error(`${file.name} is ${readableSize(file.size)} — the limit is 10 MB`); continue; }
      const id = `${Date.now()}-${Math.random()}`;
      setUploading((u) => [...u, { id, name: file.name, size: file.size }]);
      try {
        const form = new FormData();
        form.append("file", file);
        const up = await api.postForm<UploadedExpenseFile>("expenses/uploads", form);
        addAttachment({ name: up.name, key: up.key, url: up.url, size: up.size, mimeType: up.mimeType });
      } catch (err) {
        toast.error(err instanceof ApiError && err.status === 404
          ? "Uploading needs the latest finance API — ask for it to be updated"
          : `${file.name}: ${err instanceof ApiError ? err.message : "could not upload"}`);
      } finally {
        setUploading((u) => u.filter((x) => x.id !== id));
      }
    }
  }

  useEffect(() => {
    // In create mode, follow the org's display currency. In edit mode, keep the saved currency.
    if (!isEdit) setValue("currency", orgCurrency, { shouldDirty: false });
  }, [orgCurrency, isEdit]); // eslint-disable-line react-hooks/exhaustive-deps

  const currency = watch("currency");
  // Dated the organization's days back or more (1: before today): a reason, and a manager to approve it (2026-10-17).
  const lateDate = useLateDate(watch("expenseDate"), isEdit ? initialValues?.expenseDate : undefined);
  const [lateReason, setLateReason] = useState("");

  // Paid from: one of the organization's Banking accounts, its method's to start with (Settings → Where payments go).
  // Once it is paid, it shows in that account as money out.
  const { data: org } = useOrganization();
  const { data: accountList } = useBankAccounts({ isActive: "true", pageSize: 100 });
  const accounts = accountList?.data ?? [];
  const methodAccount = (m?: string) => {
    const id = m ? org?.paymentAccounts?.[m] ?? "" : "";
    return accounts.some((a) => a.id === id) ? id : NO_ACCOUNT;
  };
  // Picked by hand (or already saved): a change of method no longer moves it.
  const [accountTouched, setAccountTouched] = useState(isEdit);
  useEffect(() => {
    if (!accountTouched) setValue("bankAccountId", methodAccount(watch("paymentMethod")));
  }, [org, accountList]); // eslint-disable-line react-hooks/exhaustive-deps
  const bankAccountId = watch("bankAccountId");
  const pickedAccount = accounts.find((a) => a.id === bankAccountId);
  // What was typed before there was a list to pick from — kept while no account is picked.
  const typedAccount = (initialValues?.bankAccountId ?? NO_ACCOUNT) === NO_ACCOUNT ? (initialValues?.paymentAccount ?? "").trim() : "";
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
    if (lateDate.late && !lateReason.trim()) {
      toast.error("Give the reason it is entered late — a manager will need to approve it");
      return;
    }
    const input: CreateExpenseInput = {
      category: values.category,
      description: values.description,
      expenseDate: values.expenseDate,
      dueDate: values.dueDate || undefined,
      amountMinor: toMinor(values.amountDisplay),
      currency: values.currency,
      categoryOther: values.categoryOther ?? "",
      taxPct: values.taxPct ?? 0,
      taxInclusive: values.taxInclusive ?? false,
      paymentAccount: pickedAccount ? pickedAccount.accountName : typedAccount,
      bankAccountId: pickedAccount ? pickedAccount.id : "",
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
      // A new document goes by the key it was uploaded under; only an old link keeps its url.
      attachments: (values.attachments ?? []).map((a) => (a.key
        ? { name: a.name, key: a.key, size: a.size, mimeType: a.mimeType }
        : { name: a.name, url: a.url })),
      projectName: values.projectName ?? "",
      departmentId: values.departmentId || undefined,
      costCentre: values.costCentre ?? "",
      notes: values.notes ?? "",
      ...(lateDate.late ? { lateReason: lateReason.trim() } : {}),
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
      <QuickCreateCategoryModal
        open={categoryModalOpen}
        onClose={() => setCategoryModalOpen(false)}
        existing={categoryList}
        onCreated={(slug) => {
          setValue("category", slug, { shouldValidate: true });
          setCategoryModalOpen(false);
        }}
      />
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
              <div className="flex items-center justify-between">
                <Label>Category *</Label>
                <button
                  type="button"
                  onClick={() => setCategoryModalOpen(true)}
                  className="text-xs text-primary hover:underline flex items-center gap-0.5"
                >
                  <Plus className="h-3 w-3" /> New
                </button>
              </div>
              {/* Keyed on the value so a category created a second ago, which
                  the list is only now refetching, still shows as the choice. */}
              <Select
                key={watch("category")}
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
              <LateReasonField late={lateDate.late} days={lateDate.days} value={lateReason} onChange={setLateReason} what="expense" />
            </div>
            <div className="space-y-1.5">
              <Label>Due Date</Label>
              <Input type="date" {...register("dueDate")} />
              {/* Blank is a real answer, not a missing one: a claim nobody set
                  a deadline for cannot miss it, and will never read overdue. */}
              <p className="text-xs text-foreground-muted">
                Optional. Left blank, this never shows as overdue.
              </p>
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
                onValueChange={(v) => {
                  setValue("paymentMethod", v as ExpenseFormValues["paymentMethod"]);
                  if (!accountTouched) setValue("bankAccountId", methodAccount(v));
                }}
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
              <Select value={bankAccountId} onValueChange={(v) => { setValue("bankAccountId", v); setAccountTouched(true); }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_ACCOUNT}>Not in a bank account</SelectItem>
                  {accounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>{a.accountName}{a.currency !== currency ? ` (${a.currency})` : ""}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {pickedAccount && pickedAccount.currency !== currency ? (
                <p className="text-xs text-warning">{pickedAccount.accountName} is in {pickedAccount.currency} and this expense in {currency} — it stays out of the account's balance.</p>
              ) : pickedAccount ? (
                <p className="text-xs text-foreground-muted">Once paid, it shows in {pickedAccount.accountName} as money out.</p>
              ) : typedAccount ? (
                <p className="text-xs text-foreground-muted">Written before: “{typedAccount}”</p>
              ) : null}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Reference</Label>
            <Input {...register("reference")} placeholder="Receipt #, invoice #, etc." />
          </div>
        </div>

        {/* Project / Cost Centre */}
        <div className="rounded-lg border border-border bg-surface p-5 space-y-4">
          <h2 className="text-sm font-semibold">Project &amp; Department</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Project Name</Label>
              <Input {...register("projectName")} placeholder="e.g. Website Redesign" />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label>Department</Label>
                {canAddDepartment && (
                  <button
                    type="button"
                    onClick={() => setDeptModalOpen(true)}
                    className="text-xs font-medium text-primary hover:underline"
                  >
                    + New department
                  </button>
                )}
              </div>
              {/* Radix reads "" as unset, so "not chosen" needs a value of its
                  own. It never leaves this form. */}
              <Select
                value={watch("departmentId") || NO_DEPARTMENT}
                onValueChange={(v) =>
                  setValue("departmentId", v === NO_DEPARTMENT ? "" : v, { shouldDirty: true })
                }
              >
                <SelectTrigger><SelectValue placeholder="Select department" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_DEPARTMENT}>No department</SelectItem>
                  {(departments ?? []).map((d) => (
                    <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {/* Only for the claims that already carry one. It was free text,
                  so it was a different spelling of the same department on every
                  claim — shown so the value is not lost, not so it is typed. */}
              {legacyCostCentre && (
                <p className="text-xs text-foreground-muted">
                  Previously filed under cost centre &ldquo;{legacyCostCentre}&rdquo;.
                </p>
              )}
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

        {/* Supporting documents — uploaded, never pasted (2026-10-20) */}
        <div className="rounded-lg border border-border bg-surface p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Paperclip className="h-4 w-4 text-foreground-muted" />
              <h2 className="text-sm font-semibold">Supporting Documents</h2>
            </div>
            <input ref={fileRef} type="file" multiple accept={UPLOAD_ACCEPT} className="hidden" onChange={onFilesPicked} data-testid="expense-file-input" />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => fileRef.current?.click()}
              disabled={attachmentFields.length + uploading.length >= MAX_DOCUMENTS}
            >
              <Upload className="h-3.5 w-3.5" /> Upload files
            </Button>
          </div>
          {attachmentFields.length === 0 && uploading.length === 0 ? (
            <p className="text-sm text-foreground-muted">
              No documents yet. Upload the receipt or any supporting file — JPG, PNG, WebP, GIF or PDF, up to 10&nbsp;MB each, at most {MAX_DOCUMENTS}.
            </p>
          ) : (
            <div className="space-y-2">
              {attachmentFields.map((field, i) => {
                const a = watch(`attachments.${i}`);
                return (
                  <div key={field.id} className="flex items-center gap-2 rounded-md border border-border px-3 py-2">
                    <FileText className="h-4 w-4 shrink-0 text-foreground-muted" />
                    <Input {...register(`attachments.${i}.name`)} placeholder="Document name" className="h-8 min-w-0 flex-1" aria-label="Document name" />
                    {a?.size ? <span className="shrink-0 text-xs text-foreground-muted">{readableSize(a.size)}</span> : null}
                    {!a?.key && <span className="shrink-0 text-xs text-foreground-muted" title="Added as a link before documents had to be uploaded">Old link</span>}
                    {a?.url && (
                      <a href={a.url} target="_blank" rel="noopener noreferrer" className="shrink-0 rounded p-1 text-foreground-muted hover:text-foreground" aria-label="Open">
                        <ExternalLink className="h-4 w-4" />
                      </a>
                    )}
                    <Button type="button" variant="ghost" size="sm" onClick={() => removeAttachment(i)} aria-label="Remove">
                      <Trash2 className="h-4 w-4 text-foreground-muted" />
                    </Button>
                  </div>
                );
              })}
              {uploading.map((u) => (
                <div key={u.id} className="flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-2 text-sm text-foreground-muted">
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                  <span className="min-w-0 flex-1 truncate">Uploading {u.name}…</span>
                  <span className="shrink-0 text-xs">{readableSize(u.size)}</span>
                </div>
              ))}
            </div>
          )}
          {errors.attachments && <p className="text-xs text-danger">Name every document.</p>}
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
          <Button type="submit" loading={isSubmitting} disabled={uploading.length > 0} title={uploading.length ? "Wait for the uploads to finish" : undefined}>
            {isEdit ? "Save Changes" : "Create Expense"}
          </Button>
        </div>
      </form>

      <QuickCreateDepartmentModal
        open={deptModalOpen}
        onClose={() => setDeptModalOpen(false)}
        onCreated={(id) => setValue("departmentId", id, { shouldDirty: true })}
      />
    </div>
  );
}
