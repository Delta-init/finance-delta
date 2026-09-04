"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ProductSearchInput } from "@/features/inventory/ProductSearchInput";
import { GraduationCap, User, Wallet, Paperclip, X, FileText } from "lucide-react";
import {
  MODES_OF_STUDY,
  PAYMENT_METHODS,
  paymentMethodLabel,
  computeInvoiceLine,
  toMinor,
  formatMoney,
} from "@delta/shared";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CurrencyRateFields } from "@/components/ui/currency-rate-fields";
import { api, ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useCurrency } from "@/lib/currency-context";
import { useCreateCustomer } from "@/features/customers/api";
import { useCreateInvoice } from "@/features/invoices/api";
import { useTaxConfig } from "@/features/organization/api";
import { useColleagues } from "@/features/users/api";

/**
 * Taking an enrolment: the client, what they enrolled on, and what they paid.
 *
 * A single screen rather than the general invoice form, which asks for line
 * items, tax, due dates and terms — none of which a counsellor should be
 * thinking about while someone is signing up. Those are filled in here from
 * what the enrolment already implies.
 */
const schema = z.object({
  name: z.string().trim().min(2, "Name is required").max(120),
  email: z.string().trim().email("A valid email is required"),
  phone: z.string().trim().min(5, "Contact number is required").max(30),

  course: z.string().trim().min(1, "Course is required").max(120),
  /**
   * The catalogue item behind the course, when it came from there.
   *
   * Carried onto the invoice line so the sale is attributable to a course
   * rather than to a description somebody typed — two counsellors spelling the
   * same course differently is otherwise two products in every report.
   */
  itemId: z.string().optional(),
  courseAmount: z.string().trim().min(1, "Course amount is required"),
  modeOfStudy: z.enum(MODES_OF_STUDY),
  language: z.string().trim().min(1, "Language is required").max(60),
  meetingById: z.string().optional(),

  paidAmount: z.string().trim().optional(),
  paymentMethod: z.enum(PAYMENT_METHODS).optional(),
  enrolledOn: z.string().min(1, "Date is required"),
});
type Values = z.infer<typeof schema>;

const MODE_LABELS: Record<string, string> = {
  online: "Online",
  offline: "Offline",
  hybrid: "Hybrid",
};

/** Radix reads "" as unset, so "not chosen" needs a value that is not it. */
const NONE = "__none__";

const today = () => new Date().toISOString().slice(0, 10);

/** Ten is plenty for an ID, a signed form and a payment slip. Matches the server. */
const MAX_FILES = 10;
/** Matches what the upload middleware will accept before it refuses. */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Attach one document to an invoice that has only just been created.
 *
 * Not the `useAddInvoiceAttachment` hook, which is keyed on an id at render
 * time — here the id does not exist until the form is submitted.
 */
async function uploadTo(invoiceId: string, file: File): Promise<void> {
  const form = new FormData();
  form.append("file", file);
  await api.postForm(`invoices/${invoiceId}/attachments`, form);
}

const prettySize = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

export function EnrolmentForm() {
  const router = useRouter();
  const { data: session } = useSession();
  const { baseCurrency, rateBetween, ratesDate } = useCurrency();
  const base = baseCurrency || "AED";
  /*
   * The enrolment's own currency, not the display toggle in the header. What
   * somebody chose to look at figures in has no business deciding what currency
   * a client is billed in.
   */
  const [currency, setCurrency] = useState(base);
  const [rate, setRate] = useState("");

  // Pre-filled when the currency changes, and whenever the table finally loads.
  // Left alone once somebody has typed over it — their number is the agreed one.
  const rateTouched = useRef(false);
  useEffect(() => {
    if (rateTouched.current) return;
    const fetched = rateBetween(base, currency);
    setRate(fetched === null ? "" : String(fetched));
  }, [base, currency, rateBetween]);
  const createCustomer = useCreateCustomer();
  const createInvoice = useCreateInvoice();
  const { data: colleagues } = useColleagues();
  const { data: taxConfig } = useTaxConfig();

  /*
   * The tax the organization charges, applied to the course without asking.
   *
   * A counsellor taking an enrolment is not the person who decides whether VAT
   * applies, and every enrolment carries the same answer — so it comes from
   * Settings → Taxes rather than from a field on this form. An AED business set
   * to VAT 5% gets VAT 5%; the Bangalore organization gets its CGST and SGST,
   * which is the same rule giving a different answer rather than a special case.
   */
  const defaultTaxes = (taxConfig?.taxRates ?? [])
    .filter((r) => r.isDefault && r.appliesTo !== "purchases")
    .map((r) => ({ code: r.code, rate: r.rate }));
  const [busy, setBusy] = useState(false);
  /*
   * Documents are chosen before there is anything to attach them to — the
   * invoice does not exist until this form is submitted. So they are held here
   * and uploaded once it does, rather than making the counsellor come back to
   * a saved enrolment to add the ID they have in their hand right now.
   */
  const [files, setFiles] = useState<File[]>([]);
  const [uploaded, setUploaded] = useState(0);
  /**
   * Which catalogue item was picked, for the hint under the field.
   *
   * Worth saying out loud: an amount that fills itself in is otherwise
   * indistinguishable from one somebody typed and forgot, and the counsellor
   * needs to know which of the two they are looking at before they change it.
   */
  const [pickedItem, setPickedItem] = useState<string | null>(null);

  const {
    register, handleSubmit, setValue, watch,
    formState: { errors },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: "", email: "", phone: "",
      course: "", itemId: undefined, courseAmount: "", modeOfStudy: "online", language: "", meetingById: "",
      paidAmount: "", enrolledOn: today(),
    },
  });

  const courseMinor = toMinor(watch("courseAmount") || "0");
  const paidMinor = toMinor(watch("paidAmount") || "0");

  /*
   * What the client owes, which is the course plus tax.
   *
   * Everything below compares against this rather than the course amount: a
   * counsellor told that 1,200 leaves nothing outstanding, on an invoice for
   * 1,260, has been told the wrong thing at the only moment it matters.
   */
  const line = computeInvoiceLine({ quantity: 1, unitPriceMinor: courseMinor, taxes: defaultTaxes });
  const taxMinor = line.taxTotalMinor;
  const dueMinor = line.lineTotalMinor;


  const rateMissing = currency !== base && !(Number(rate) > 0);

  async function onSubmit(v: Values) {
    if (rateMissing) {
      toast.error(`Enter what 1 ${base} is worth in ${currency} before saving.`);
      return;
    }
    setBusy(true);
    try {
      // The client first: an invoice needs somebody to bill, and a counsellor
      // taking an enrolment is usually meeting them for the first time.
      const customer = await createCustomer.mutateAsync({
        name: v.name,
        email: v.email,
        phone: v.phone,
        currency,
      } as never);

      const invoice = await createInvoice.mutateAsync({
        customerId: customer.id,
        // Pinned to whoever is signed in by the server regardless; sent so the
        // form satisfies its own validation.
        salespersonId: session?.user?.id ?? "",
        issueDate: v.enrolledOn,
        // Enrolments are paid at the point of sale, so the invoice is due the
        // day it is raised rather than on terms nobody agreed.
        dueDate: v.enrolledOn,
        currency,
        exchangeRate: Number(rate) || undefined,
        lineItems: [
          {
            description: v.course,
            quantity: 1,
            unitPriceMinor: courseMinor,
            // Only when it came from the catalogue. A typed course has no item
            // to point at, and inventing one here would be a second source of
            // products nobody curates.
            ...(v.itemId ? { itemId: v.itemId } : {}),
            taxes: defaultTaxes,
          },
        ],
        enrolment: {
          course: v.course,
          modeOfStudy: v.modeOfStudy,
          language: v.language,
          meetingById: v.meetingById || undefined,
          declaredPaidMinor: paidMinor,
          declaredPaymentMethod: v.paymentMethod,
        },
      } as never);

      // One at a time, so a rejected file names itself rather than failing the
      // batch anonymously. The enrolment is already saved by this point: a
      // document that will not upload is worth saying so about, not worth
      // throwing the enrolment away over.
      const failed: string[] = [];
      for (const file of files) {
        try {
          await uploadTo(invoice.id, file);
          setUploaded((n) => n + 1);
        } catch {
          failed.push(file.name);
        }
      }

      if (failed.length > 0) {
        toast.error(
          `${invoice.invoiceNumber} saved, but ${failed.length === 1 ? "this document did" : "these documents did"} not upload: ${failed.join(", ")}. Add ${failed.length === 1 ? "it" : "them"} from the enrolment.`,
        );
      } else {
        toast.success(`${invoice.invoiceNumber} sent for approval`);
      }
      router.push(`/invoices/${invoice.id}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not save the enrolment");
    } finally {
      setBusy(false);
      setUploaded(0);
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 p-6">
      <PageHeader
        icon={GraduationCap}
        title="New enrolment"
        description="The client, the course and what they paid. An approver checks it before anything reaches them."
      />

      <Card className="space-y-4 p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <User className="h-4 w-4 text-foreground-muted" /> Client
        </h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Name" error={errors.name?.message}>
            <Input {...register("name")} placeholder="Fajin" />
          </Field>
          <Field label="Email" error={errors.email?.message}>
            <Input type="email" {...register("email")} placeholder="name@example.com" />
          </Field>
          <Field label="Contact number" error={errors.phone?.message}>
            <Input {...register("phone")} placeholder="+971 50 000 0000" />
          </Field>
        </div>
      </Card>

      <Card className="space-y-4 p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <GraduationCap className="h-4 w-4 text-foreground-muted" /> Course
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field
            label="Course"
            error={errors.course?.message}
            hint={pickedItem ? `From the catalogue · ${pickedItem}` : undefined}
          >
            {/* The same picker the invoice line items use, so a course that is
                in the catalogue brings its price with it and the two documents
                cannot disagree about what it costs. Typing a course that is not
                in there still works — a new course sells before somebody gets
                round to adding it. */}
            <ProductSearchInput
              query={watch("course") ?? ""}
              registerProps={register("course")}
              onType={() => {
                // Edited by hand: the link to the catalogue item is gone, and
                // the price is now whatever the counsellor says it is.
                setValue("itemId", undefined);
                setPickedItem(null);
              }}
              onPick={(item) => {
                setValue("course", item.name, { shouldDirty: true, shouldValidate: true });
                setValue("courseAmount", String(item.unitPriceMinor / 100), {
                  shouldDirty: true,
                  shouldValidate: true,
                });
                setValue("itemId", item.id, { shouldDirty: true });
                setPickedItem(item.sku || item.name);
              }}
              currency={currency}
            />
          </Field>
          <Field label={`Course amount (${currency})`} error={errors.courseAmount?.message}>
            <Input type="number" min="0" step="0.01" {...register("courseAmount")} placeholder="0.00" />
          </Field>
          {/* What the client is actually asked for. The tax is not a field —
              it is what the organization charges — but leaving it off the
              screen means quoting the course price and invoicing something
              else. */}
          {courseMinor > 0 && taxMinor > 0 && (
            <div className="flex flex-wrap gap-x-6 gap-y-1 rounded-md border border-border bg-surface-muted px-3 py-2 text-xs sm:col-span-2 lg:col-span-4">
              <span className="text-foreground-muted">
                Course <span className="font-numeric font-medium text-foreground">{formatMoney(courseMinor, currency)}</span>
              </span>
              {line.taxes.map((t) => (
                <span key={t.code} className="text-foreground-muted">
                  {t.code} {t.rate}%{" "}
                  <span className="font-numeric font-medium text-foreground">{formatMoney(t.amountMinor, currency)}</span>
                </span>
              ))}
              <span className="text-foreground-muted">
                Total <span className="font-numeric font-semibold text-foreground">{formatMoney(dueMinor, currency)}</span>
              </span>
            </div>
          )}

          <CurrencyRateFields
            currency={currency}
            onCurrencyChange={(c) => { rateTouched.current = false; setCurrency(c); }}
            baseCurrency={base}
            rate={rate}
            onRateChange={(r) => { rateTouched.current = true; setRate(r); }}
            ratesDate={ratesDate}
            amountMinor={dueMinor}
          />
          <Field label="Mode of study">
            <Select value={watch("modeOfStudy")} onValueChange={(x) => setValue("modeOfStudy", x as Values["modeOfStudy"])}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {MODES_OF_STUDY.map((m) => (
                  <SelectItem key={m} value={m}>{MODE_LABELS[m]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Language" error={errors.language?.message}>
            <Input {...register("language")} placeholder="Malayalam" />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Salesperson" hint="Leave it as “That was me” if the enrolment was yours.">
            {/* Picked, not typed: "Yamini", "yamini" and "Yamini K" are three
                people as far as any report is concerned. */}
            <Select
              value={watch("meetingById") || NONE}
              onValueChange={(v) => setValue("meetingById", v === NONE ? "" : v, { shouldDirty: true })}
            >
              <SelectTrigger><SelectValue placeholder="That was me" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>That was me</SelectItem>
                {(colleagues ?? []).map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Enrolled on" error={errors.enrolledOn?.message}>
            <Input type="date" {...register("enrolledOn")} />
          </Field>
        </div>
      </Card>

      <Card className="space-y-4 p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Wallet className="h-4 w-4 text-foreground-muted" /> Payment taken
        </h2>
        {/* Said plainly, because a counsellor who types an amount here will
            otherwise assume the invoice is settled. */}
        <p className="text-sm text-foreground-muted">
          Record what the client actually paid you. It is not marked against the invoice until an
          approver has checked it.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={`Paid amount (${currency})`} hint={taxMinor > 0 ? `Of ${formatMoney(dueMinor, currency)} due` : undefined}>
            <Input type="number" min="0" step="0.01" {...register("paidAmount")} placeholder="0.00" />
          </Field>
          <Field label="Payment mode">
            {/* Radix reads an empty string as "no value", so unset needs a
                sentinel of its own rather than "". It never leaves this form. */}
            <Select
              value={watch("paymentMethod") ?? NONE}
              onValueChange={(x) =>
                setValue("paymentMethod", x === NONE ? undefined : (x as Values["paymentMethod"]))
              }
            >
              <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Not taken yet</SelectItem>
                {PAYMENT_METHODS.map((m) => (
                  <SelectItem key={m} value={m}>{paymentMethodLabel(m)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>

        {courseMinor > 0 && paidMinor > 0 && paidMinor < dueMinor && (
          <p className="rounded-lg border border-warning/30 bg-warning/5 p-2.5 text-xs">
            {formatMoney(dueMinor - paidMinor, currency)} will remain outstanding after this.
          </p>
        )}
        {paidMinor > dueMinor && courseMinor > 0 && (
          <p className="rounded-lg border border-danger/30 bg-danger/5 p-2.5 text-xs text-danger">
            That is more than the enrolment comes to. Check the two figures.
          </p>
        )}
      </Card>

      <Card className="space-y-4 p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Paperclip className="h-4 w-4 text-foreground-muted" /> Documents
          <span className="font-normal text-foreground-muted">— optional</span>
        </h2>
        <p className="text-sm text-foreground-muted">
          Anything supporting the enrolment: an ID, a signed form, a payment slip. Photos and
          documents both. Up to {MAX_FILES}, {prettySize(MAX_FILE_BYTES)} each.
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <label
            className={`inline-flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-muted ${
              files.length >= MAX_FILES ? "pointer-events-none opacity-50" : ""
            }`}
          >
            <Paperclip className="h-4 w-4" />
            Choose files
            <input
              type="file"
              multiple
              accept="image/*,application/pdf,.doc,.docx"
              className="hidden"
              onChange={(e) => {
                const picked = Array.from(e.target.files ?? []);
                // Said now rather than after the enrolment is saved, when it is
                // too late to pick a smaller one.
                const tooBig = picked.filter((f) => f.size > MAX_FILE_BYTES);
                if (tooBig.length > 0) {
                  toast.error(
                    `${tooBig.map((f) => f.name).join(", ")} — over ${prettySize(MAX_FILE_BYTES)}, so not added.`,
                  );
                }
                const room = MAX_FILES - files.length;
                const ok = picked.filter((f) => f.size <= MAX_FILE_BYTES).slice(0, room);
                if (picked.length - tooBig.length > room) {
                  toast.error(`Only ${MAX_FILES} documents in total, so the rest were not added.`);
                }
                setFiles((prev) => [...prev, ...ok]);
                // Cleared so choosing the same file again still registers.
                e.target.value = "";
              }}
            />
          </label>
          {files.length > 0 && (
            <span className="text-xs text-foreground-muted">
              {files.length} of {MAX_FILES} chosen
              {busy && files.length > 0 ? ` · uploading ${uploaded + 1} of ${files.length}` : ""}
            </span>
          )}
        </div>

        {files.length > 0 && (
          <ul className="space-y-1.5">
            {files.map((f, i) => (
              <li
                key={`${f.name}-${i}`}
                className="flex items-center gap-3 rounded-md border border-border px-3 py-2"
              >
                <FileText className="h-4 w-4 shrink-0 text-foreground-muted" />
                <span className="min-w-0 flex-1 truncate text-sm">{f.name}</span>
                <span className="shrink-0 text-xs text-foreground-muted">{prettySize(f.size)}</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                  className="shrink-0 text-foreground-subtle hover:text-danger disabled:opacity-50"
                  aria-label={`Remove ${f.name}`}
                >
                  <X className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="flex items-center justify-end gap-3">
        <Button type="button" variant="ghost" onClick={() => router.back()}>Cancel</Button>
        <Button type="submit" loading={busy} disabled={rateMissing}>Send for approval</Button>
      </div>
    </form>
  );
}

function Field({
  label, error, hint, children,
}: { label: string; error?: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint && !error && <p className="text-xs text-foreground-muted">{hint}</p>}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
