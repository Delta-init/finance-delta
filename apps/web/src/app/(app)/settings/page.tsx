"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  updateOrganizationSchema,
  taxNumberLabel,
  defaultInvoiceTitle,
  type UpdateOrganizationInput,
} from "@delta/shared";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";
import { ApiError } from "@/lib/api";
import { useOrganization, useUpdateOrganization, useTaxConfig } from "@/features/organization/api";
import { useBankAccounts } from "@/features/banking/api";
import { Plus, X, Receipt, ChevronRight } from "lucide-react";

const FIELD = "h-9 w-full rounded-md border border-border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30";

const CURRENCIES = ["AED", "USD", "EUR", "GBP", "INR", "SAR", "QAR", "KWD", "BHD", "OMR"];

export default function SettingsPage() {
  const { data: org, isLoading } = useOrganization();
  const { data: taxConfig } = useTaxConfig();
  const update = useUpdateOrganization();
  // Only active accounts: an invoice should not tell a client to pay into an
  // account the organization has closed.
  const { data: accounts } = useBankAccounts({ isActive: "true", pageSize: 100 });

  const [intervalInput, setIntervalInput] = useState("");
  const [intervals, setIntervals] = useState<number[]>([]);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<UpdateOrganizationInput>({
    resolver: zodResolver(updateOrganizationSchema),
  });

  useEffect(() => {
    if (org) {
      setIntervals(org.reminderIntervals ?? [-3, 1, 7]);
      reset({
        name: org.name,
        legalName: org.legalName,
        baseCurrency: org.baseCurrency,
        branding: {
          logoUrl: org.branding.logoUrl,
          primaryColor: org.branding.primaryColor,
          footerText: org.branding.footerText,
        },
        address: { ...org.address },
        phone: org.phone,
        email: org.email,
        website: org.website,
        taxRegistrationNumber: org.taxRegistrationNumber,
        registrationNumber: org.registrationNumber,
        invoiceDefaults: { ...org.invoiceDefaults },
        reminderIntervals: org.reminderIntervals ?? [-3, 1, 7],
      });
    }
  }, [org, reset]);

  function addInterval() {
    const v = parseInt(intervalInput, 10);
    if (isNaN(v)) return;
    if (intervals.includes(v)) return;
    setIntervals((prev) => [...prev, v].sort((a, b) => a - b));
    setIntervalInput("");
  }

  function removeInterval(v: number) {
    setIntervals((prev) => prev.filter((x) => x !== v));
  }

  async function onSubmit(data: UpdateOrganizationInput) {
    try {
      await update.mutateAsync({ ...data, reminderIntervals: intervals });
      toast.success("Organization settings saved");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to save settings");
    }
  }

  if (isLoading) {
    return <div className="p-6 text-sm text-foreground-muted">Loading…</div>;
  }

  // The number is one field; only what it is called changes with where the
  // organization trades, so the form asks for GSTIN in India and TRN in the UAE.
  const taxSystem = taxConfig?.taxSystem ?? org?.taxSystem;
  const regLabel = taxNumberLabel(taxSystem);
  const titlePlaceholder = defaultInvoiceTitle(taxSystem, org?.taxRegistrationNumber);

  return (
    <div className="mx-auto max-w-3xl space-y-8 p-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Organization Settings</h1>
        <p className="mt-1 text-sm text-foreground-muted">
          Your organization&apos;s own details, as they appear on the invoices and quotations you issue.
        </p>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        {/* Identity */}
        <section className="rounded-xl border border-border bg-surface p-5 space-y-4">
          <h2 className="text-sm font-semibold text-foreground">Identity</h2>

          <div className="space-y-1">
            <label className="text-sm font-medium text-foreground">Organization name</label>
            <input
              {...register("name")}
              className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
              placeholder="Delta Finance"
            />
            {errors.name && <p className="text-xs text-danger">{errors.name.message}</p>}
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium text-foreground">Legal name</label>
            <input
              {...register("legalName")}
              className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
              placeholder="Delta Finance LLC"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <label className="text-sm font-medium text-foreground">{regLabel}</label>
              <input {...register("taxRegistrationNumber")} className={FIELD} placeholder={regLabel === "GSTIN" ? "29ABCDE1234F1Z5" : "100123456700003"} />
              <p className="text-xs text-foreground-muted">Printed on every invoice. Leave blank if not registered.</p>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium text-foreground">Company registration no.</label>
              <input {...register("registrationNumber")} className={FIELD} placeholder="CIN / licence number" />
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium text-foreground">Base currency</label>
            <select
              {...register("baseCurrency")}
              className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
            >
              {CURRENCIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
        </section>

        {/* Address & contact */}
        <section className="rounded-xl border border-border bg-surface p-5 space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Address &amp; contact</h2>
            <p className="mt-1 text-xs text-foreground-muted">
              Where the organization trades. This heads every invoice — without it an invoice is
              a statement of what somebody owes rather than a document they can file.
            </p>
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium text-foreground">Address line 1</label>
            <input {...register("address.line1")} className={FIELD} placeholder="Building, street" />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium text-foreground">Address line 2</label>
            <input {...register("address.line2")} className={FIELD} placeholder="Area, landmark" />
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1">
              <label className="text-sm font-medium text-foreground">City</label>
              <input {...register("address.city")} className={FIELD} placeholder="Dubai" />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium text-foreground">State / Emirate</label>
              <input {...register("address.state")} className={FIELD} placeholder="Kerala" />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium text-foreground">Postcode</label>
              <input {...register("address.postcode")} className={FIELD} placeholder="673001" />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <label className="text-sm font-medium text-foreground">Country</label>
              <input {...register("address.country")} className={FIELD} placeholder="United Arab Emirates" />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium text-foreground">Phone</label>
              <input {...register("phone")} className={FIELD} placeholder="+971 4 000 0000" />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium text-foreground">Email</label>
              <input {...register("email")} className={FIELD} placeholder="accounts@example.com" />
              {errors.email && <p className="text-xs text-danger">{errors.email.message}</p>}
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium text-foreground">Website</label>
              <input {...register("website")} className={FIELD} placeholder="www.example.com" />
            </div>
          </div>
        </section>

        {/* Invoice defaults */}
        <section className="rounded-xl border border-border bg-surface p-5 space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Invoice defaults</h2>
            <p className="mt-1 text-xs text-foreground-muted">
              What a new invoice starts from. Changing these leaves invoices already issued
              exactly as they went out.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1">
              <label className="text-sm font-medium text-foreground">Document title</label>
              <input {...register("invoiceDefaults.title")} className={FIELD} placeholder={titlePlaceholder} />
              <p className="text-xs text-foreground-muted">Blank uses “{titlePlaceholder}”.</p>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium text-foreground">Number prefix</label>
              <input {...register("invoiceDefaults.prefix")} className={FIELD} placeholder="IN-" />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium text-foreground">Digits</label>
              <input type="number" min={1} max={10} {...register("invoiceDefaults.numberPad")} className={FIELD} placeholder="5" />
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium text-foreground">Bank account to print</label>
            <select {...register("invoiceDefaults.bankAccountId")} className={FIELD}>
              <option value="">Do not print bank details</option>
              {(accounts?.data ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.accountName}{a.bankName ? ` — ${a.bankName}` : ""} ({a.currency})
                </option>
              ))}
            </select>
            <p className="text-xs text-foreground-muted">
              The account clients are told to pay into. Its IFSC, SWIFT and IBAN are set on the
              account itself, under Banking.
            </p>
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium text-foreground">Default terms</label>
            <textarea
              {...register("invoiceDefaults.terms")}
              rows={3}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
              placeholder="Payment due on receipt. Goods once sold are not returnable."
            />
            <p className="text-xs text-foreground-muted">Pre-fills the terms box on a new invoice; each invoice can still say something else.</p>
          </div>
        </section>

        {/* Branding */}
        <section className="rounded-xl border border-border bg-surface p-5 space-y-4">
          <h2 className="text-sm font-semibold text-foreground">Branding</h2>
          <p className="text-xs text-foreground-muted">
            These appear on printed invoices and quotations.
          </p>

          <div className="space-y-1">
            <label className="text-sm font-medium text-foreground">Logo URL</label>
            <input
              {...register("branding.logoUrl")}
              className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
              placeholder="https://example.com/logo.png"
            />
            {errors.branding?.logoUrl && (
              <p className="text-xs text-danger">{errors.branding.logoUrl.message}</p>
            )}
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium text-foreground">Primary color</label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                {...register("branding.primaryColor")}
                className="h-9 w-12 cursor-pointer rounded-md border border-border bg-background p-1"
              />
              <input
                {...register("branding.primaryColor")}
                className="h-9 flex-1 rounded-md border border-border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
                placeholder="#2563eb"
              />
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium text-foreground">Footer text</label>
            <input
              {...register("branding.footerText")}
              className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
              placeholder="Thank you for your business!"
            />
          </div>
        </section>

        {/* Payment Reminders */}
        <section className="rounded-xl border border-border bg-surface p-5 space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Payment Reminders</h2>
            <p className="mt-1 text-xs text-foreground-muted">
              Days relative to due date when reminder emails are sent. Negative = before due, positive = after due.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            {intervals.sort((a, b) => a - b).map((v) => (
              <span key={v} className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-3 py-1 text-xs font-medium">
                {v >= 0 ? `+${v}` : `${v}`} days
                <button type="button" onClick={() => removeInterval(v)} className="ml-1 text-foreground-muted hover:text-danger">
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            {intervals.length === 0 && (
              <span className="text-xs text-foreground-muted">No reminders configured</span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <input
              type="number"
              value={intervalInput}
              onChange={(e) => setIntervalInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addInterval())}
              placeholder="e.g. -3 or 7"
              className="h-9 w-32 rounded-md border border-border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
            />
            <Button type="button" variant="secondary" size="sm" onClick={addInterval}>
              <Plus className="h-4 w-4" /> Add
            </Button>
          </div>
        </section>

        <div className="flex justify-end">
          <Button type="submit" loading={isSubmitting}>
            Save settings
          </Button>
        </div>
      </form>

      {/* Tax Settings link card */}
      <Link
        href="/settings/taxes"
        className="group flex items-center justify-between rounded-xl border border-border bg-surface p-5 transition-colors hover:border-primary"
      >
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Receipt className="h-4 w-4" />
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground">Tax Settings</p>
            <p className="text-xs text-foreground-muted">
              {taxConfig
                ? `${taxConfig.taxLabel} · ${taxConfig.taxRates.length} rate${taxConfig.taxRates.length !== 1 ? "s" : ""} configured`
                : "Configure tax system and rates"}
            </p>
          </div>
        </div>
        <ChevronRight className="h-4 w-4 text-foreground-muted transition-transform group-hover:translate-x-0.5" />
      </Link>
    </div>
  );
}
