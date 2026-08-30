"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { GraduationCap, User, Wallet } from "lucide-react";
import { MODES_OF_STUDY, PAYMENT_METHODS, toMinor, formatMoney } from "@delta/shared";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useCurrency } from "@/lib/currency-context";
import { useCreateCustomer } from "@/features/customers/api";
import { useCreateInvoice } from "@/features/invoices/api";

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
  courseAmount: z.string().trim().min(1, "Course amount is required"),
  modeOfStudy: z.enum(MODES_OF_STUDY),
  language: z.string().trim().min(1, "Language is required").max(60),
  meetingBy: z.string().trim().max(120).optional(),

  paidAmount: z.string().trim().optional(),
  paymentMethod: z.enum(PAYMENT_METHODS).optional(),
  enrolledOn: z.string().min(1, "Date is required"),
});
type Values = z.infer<typeof schema>;

const METHOD_LABELS: Record<string, string> = {
  cash: "Cash",
  bank_transfer: "Bank transfer",
  cheque: "Cheque",
  card: "Card",
  easebuzz_emi: "Easebuzz EMI",
  tabby: "Tabby",
  other: "Other",
};
const MODE_LABELS: Record<string, string> = {
  online: "Online",
  offline: "Offline",
  hybrid: "Hybrid",
};

/** Radix reads "" as unset, so "not chosen" needs a value that is not it. */
const NONE = "__none__";

const today = () => new Date().toISOString().slice(0, 10);

export function EnrolmentForm() {
  const router = useRouter();
  const { data: session } = useSession();
  const { baseCurrency } = useCurrency();
  const createCustomer = useCreateCustomer();
  const createInvoice = useCreateInvoice();
  const [busy, setBusy] = useState(false);

  const {
    register, handleSubmit, setValue, watch,
    formState: { errors },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: "", email: "", phone: "",
      course: "", courseAmount: "", modeOfStudy: "online", language: "", meetingBy: "",
      paidAmount: "", enrolledOn: today(),
    },
  });

  const courseMinor = toMinor(watch("courseAmount") || "0");
  const paidMinor = toMinor(watch("paidAmount") || "0");
  const currency = baseCurrency || "AED";

  async function onSubmit(v: Values) {
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
        lineItems: [{ description: v.course, quantity: 1, unitPriceMinor: courseMinor }],
        enrolment: {
          course: v.course,
          modeOfStudy: v.modeOfStudy,
          language: v.language,
          meetingBy: v.meetingBy ?? "",
          declaredPaidMinor: paidMinor,
          declaredPaymentMethod: v.paymentMethod,
        },
      } as never);

      toast.success(`${invoice.invoiceNumber} sent for approval`);
      router.push(`/invoices/${invoice.id}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not save the enrolment");
    } finally {
      setBusy(false);
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
          <Field label="Course" error={errors.course?.message}>
            <Input {...register("course")} placeholder="MBT" />
          </Field>
          <Field label={`Course amount (${currency})`} error={errors.courseAmount?.message}>
            <Input type="number" min="0" step="0.01" {...register("courseAmount")} placeholder="0.00" />
          </Field>
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
          <Field label="Meeting done by" hint="Leave blank if that was you.">
            <Input {...register("meetingBy")} placeholder="Yamini" />
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
          <Field label={`Paid amount (${currency})`}>
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
                  <SelectItem key={m} value={m}>{METHOD_LABELS[m] ?? m}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>

        {courseMinor > 0 && paidMinor > 0 && paidMinor < courseMinor && (
          <p className="rounded-lg border border-warning/30 bg-warning/5 p-2.5 text-xs">
            {formatMoney(courseMinor - paidMinor, currency)} will remain outstanding after this.
          </p>
        )}
        {paidMinor > courseMinor && courseMinor > 0 && (
          <p className="rounded-lg border border-danger/30 bg-danger/5 p-2.5 text-xs text-danger">
            That is more than the course costs. Check the two figures.
          </p>
        )}
      </Card>

      <div className="flex items-center justify-end gap-3">
        <Button type="button" variant="ghost" onClick={() => router.back()}>Cancel</Button>
        <Button type="submit" loading={busy}>Send for approval</Button>
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
