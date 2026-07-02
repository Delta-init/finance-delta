"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { updateOrganizationSchema, type UpdateOrganizationInput } from "@delta/shared";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";
import { ApiError } from "@/lib/api";
import { useOrganization, useUpdateOrganization, useTaxConfig } from "@/features/organization/api";
import { Plus, X, Receipt, ChevronRight } from "lucide-react";

const CURRENCIES = ["AED", "USD", "EUR", "GBP", "INR", "SAR", "QAR", "KWD", "BHD", "OMR"];

export default function SettingsPage() {
  const { data: org, isLoading } = useOrganization();
  const { data: taxConfig } = useTaxConfig();
  const update = useUpdateOrganization();

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

  return (
    <div className="mx-auto max-w-2xl space-y-8 p-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Organization Settings</h1>
        <p className="mt-1 text-sm text-foreground-muted">
          Manage your organization profile and branding used on invoices and quotations.
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
