"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2, Receipt } from "lucide-react";
import {
  TAX_SYSTEMS, TAX_SYSTEM_META, TAX_SYSTEM_PRESETS,
  type TaxSystem, type TaxConfigItem,
} from "@delta/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/page-header";
import { toast } from "@/lib/toast";
import { ApiError } from "@/lib/api";
import { useTaxConfig, useUpsertTaxConfig } from "@/features/organization/api";

const APPLIES_LABELS = { sales: "Sales only", purchases: "Purchases only", both: "Both" };
const CODE_OPTIONS = ["VAT", "GST", "TDS", "WHT", "OTHER"];

function emptyRate(): TaxConfigItem {
  return { label: "", code: "VAT", rate: 0, isDefault: false, appliesTo: "both" };
}

export default function TaxSettingsPage() {
  const { data: config, isLoading } = useTaxConfig();
  const upsert = useUpsertTaxConfig();

  const [taxSystem, setTaxSystem] = useState<TaxSystem>("vat");
  const [taxLabel, setTaxLabel] = useState("VAT");
  const [rates, setRates] = useState<TaxConfigItem[]>([]);
  const [isDirty, setIsDirty] = useState(false);

  useEffect(() => {
    if (config) {
      setTaxSystem(config.taxSystem);
      setTaxLabel(config.taxLabel);
      setRates(config.taxRates);
      setIsDirty(false);
    }
  }, [config]);

  function handleSystemChange(sys: TaxSystem) {
    setTaxSystem(sys);
    setTaxLabel(TAX_SYSTEM_META[sys].defaultLabel);
    setIsDirty(true);
  }

  function applyPresets() {
    const presets = TAX_SYSTEM_PRESETS[taxSystem];
    setRates(presets.map((p) => ({ ...p })));
    setIsDirty(true);
  }

  function addRate() {
    setRates((prev) => [...prev, emptyRate()]);
    setIsDirty(true);
  }

  function updateRate(i: number, patch: Partial<TaxConfigItem>) {
    setRates((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
    setIsDirty(true);
  }

  function removeRate(i: number) {
    setRates((prev) => prev.filter((_, idx) => idx !== i));
    setIsDirty(true);
  }

  async function handleSave() {
    try {
      await upsert.mutateAsync({ taxSystem, taxLabel, taxRates: rates });
      toast.success("Tax settings saved");
      setIsDirty(false);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to save");
    }
  }

  if (isLoading) return <div className="p-6 text-sm text-foreground-muted">Loading…</div>;

  const hasPresets = TAX_SYSTEM_PRESETS[taxSystem].length > 0;

  return (
    <div className="mx-auto max-w-2xl space-y-8 p-6">
      <PageHeader
        icon={Receipt}
        title="Tax Settings"
        description="Configure your tax system and rates. These auto-fill on every new document line item."
      />

      {/* Tax System Switcher */}
      <section className="rounded-xl border border-border bg-surface p-5 space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Tax System</h2>
          <p className="mt-0.5 text-xs text-foreground-muted">Choose the tax regime your organisation uses.</p>
        </div>

        <div className="flex flex-wrap gap-2">
          {TAX_SYSTEMS.map((sys) => (
            <button
              key={sys}
              type="button"
              onClick={() => handleSystemChange(sys)}
              className={[
                "rounded-lg border px-4 py-2 text-sm font-medium transition-colors",
                taxSystem === sys
                  ? "border-primary bg-primary text-white"
                  : "border-border bg-background text-foreground hover:border-primary hover:text-primary",
              ].join(" ")}
            >
              {TAX_SYSTEM_META[sys].defaultLabel === "Tax"
                ? TAX_SYSTEM_META[sys].label
                : TAX_SYSTEM_META[sys].defaultLabel}
            </button>
          ))}
        </div>

        {/* Custom label input */}
        <div className="space-y-1">
          <label className="text-xs font-medium text-foreground-muted">
            Label shown on documents
            {taxSystem !== "custom" && (
              <span className="ml-1 text-foreground-subtle">(auto-set, can override)</span>
            )}
          </label>
          <div className="flex items-center gap-2">
            <Input
              value={taxLabel}
              onChange={(e) => { setTaxLabel(e.target.value); setIsDirty(true); }}
              placeholder="e.g. VAT, GST, Tax"
              className="max-w-[160px]"
              maxLength={20}
            />
            <span className="text-xs text-foreground-muted">This label replaces "Tax" everywhere in the app and on printed documents.</span>
          </div>
        </div>
      </section>

      {/* Tax Rates */}
      <section className="rounded-xl border border-border bg-surface p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Tax Rates</h2>
            <p className="mt-0.5 text-xs text-foreground-muted">
              Rates marked as default auto-fill when adding new document lines.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {hasPresets && (
              <Button type="button" variant="ghost" size="sm" onClick={applyPresets}>
                Apply {TAX_SYSTEM_META[taxSystem].defaultLabel} presets
              </Button>
            )}
            <Button type="button" variant="outline" size="sm" onClick={addRate}>
              <Plus className="h-3.5 w-3.5" /> Add Rate
            </Button>
          </div>
        </div>

        {rates.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border py-8 text-center text-sm text-foreground-muted">
            No tax rates configured.{hasPresets && " Click \"Apply presets\" to get started."}
          </div>
        ) : (
          <div className="space-y-2">
            {/* Header */}
            <div className="grid grid-cols-[1fr_100px_80px_140px_80px_32px] gap-2 px-1">
              {["Label", "Code", "Rate (%)", "Applies to", "Default?", ""].map((h) => (
                <span key={h} className="text-xs font-medium uppercase tracking-wide text-foreground-muted">{h}</span>
              ))}
            </div>

            {rates.map((rate, i) => (
              <div
                key={i}
                className="grid grid-cols-[1fr_100px_80px_140px_80px_32px] items-center gap-2 rounded-lg border border-border bg-background px-3 py-2"
              >
                <Input
                  value={rate.label}
                  onChange={(e) => updateRate(i, { label: e.target.value })}
                  placeholder="e.g. VAT"
                  className="h-8 text-sm"
                />
                <select
                  value={rate.code}
                  onChange={(e) => updateRate(i, { code: e.target.value })}
                  className="h-8 w-full rounded-md border border-border bg-surface px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
                >
                  {CODE_OPTIONS.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
                <div className="relative">
                  <Input
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    value={rate.rate}
                    onChange={(e) => updateRate(i, { rate: parseFloat(e.target.value) || 0 })}
                    className="h-8 pr-6 text-sm"
                  />
                  <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-foreground-muted">%</span>
                </div>
                <select
                  value={rate.appliesTo}
                  onChange={(e) => updateRate(i, { appliesTo: e.target.value as TaxConfigItem["appliesTo"] })}
                  className="h-8 w-full rounded-md border border-border bg-surface px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
                >
                  {(Object.keys(APPLIES_LABELS) as TaxConfigItem["appliesTo"][]).map((k) => (
                    <option key={k} value={k}>{APPLIES_LABELS[k]}</option>
                  ))}
                </select>
                <div className="flex justify-center">
                  <input
                    type="checkbox"
                    checked={rate.isDefault}
                    onChange={(e) => updateRate(i, { isDefault: e.target.checked })}
                    className="h-4 w-4 rounded border-border accent-primary cursor-pointer"
                    title="Auto-fill on new lines"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => removeRate(i)}
                  className="flex h-7 w-7 items-center justify-center rounded text-foreground-muted hover:text-danger"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="flex items-center justify-between">
        <p className="text-xs text-foreground-muted">
          Changes apply to new documents only — existing documents keep their saved rates.
        </p>
        <Button onClick={handleSave} loading={upsert.isPending} disabled={!isDirty}>
          Save Tax Settings
        </Button>
      </div>
    </div>
  );
}
