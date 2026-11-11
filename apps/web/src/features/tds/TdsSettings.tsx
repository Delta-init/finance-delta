"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { TdsSection } from "@delta/shared";
import { TDS_DEFAULT_SECTIONS } from "@delta/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useTdsConfig, useUpdateTdsConfig } from "./api";

/**
 * TDS sections and rates (Bangalore, 2026-11-11: "TDS section required") — only where the organization keeps its books
 * in INR. A bill names one of these; its rate then is kept on the bill, so changing a rate leaves old bills as they were.
 */
export function TdsSettings() {
  const { data: cfg } = useTdsConfig();
  const save = useUpdateTdsConfig();
  const [enabled, setEnabled] = useState(true);
  const [sections, setSections] = useState<TdsSection[]>([]);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (cfg) { setEnabled(cfg.enabled); setSections(cfg.sections); setDirty(false); }
  }, [cfg]);
  if (!cfg?.available) return null;

  const change = (i: number, patch: Partial<TdsSection>) => { setSections((p) => p.map((s, k) => (k === i ? { ...s, ...patch } : s))); setDirty(true); };
  const submit = async () => {
    try {
      await save.mutateAsync({ enabled, sections: sections.map((s) => ({ ...s, code: s.code.trim().toUpperCase(), label: s.label.trim() })) });
      toast.success("TDS saved");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not save TDS");
    }
  };

  return (
    <section className="space-y-4 rounded-lg border border-border bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">TDS — tax deducted at source</h2>
          <p className="mt-1 max-w-2xl text-sm text-foreground-muted">
            Deducted from vendor bills under a section: worked out on the bill before GST, rounded to the rupee, and taken
            off what the vendor is paid. A vendor&apos;s own section is used for their new bills. Check the rates —
            thresholds aren&apos;t applied; choose “No TDS” on a bill below them.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" className="h-4 w-4 accent-primary" checked={enabled} onChange={(e) => { setEnabled(e.target.checked); setDirty(true); }} />
          Deduct TDS on bills
        </label>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-foreground-subtle">
            <tr><th className="py-2 pr-2">Code</th><th className="py-2 pr-2">Section</th><th className="w-24 py-2 pr-2">Rate %</th><th className="w-16 py-2 pr-2">Use</th><th className="w-10" /></tr>
          </thead>
          <tbody>
            {sections.map((s, i) => (
              <tr key={i} className="border-t border-border">
                <td className="py-1.5 pr-2"><Input value={s.code} onChange={(e) => change(i, { code: e.target.value })} className="h-8 uppercase" /></td>
                <td className="py-1.5 pr-2"><Input value={s.label} onChange={(e) => change(i, { label: e.target.value })} className="h-8" /></td>
                <td className="py-1.5 pr-2"><Input type="number" step="0.01" min={0} max={100} value={s.ratePct} onChange={(e) => change(i, { ratePct: Number(e.target.value) })} className="h-8" /></td>
                <td className="py-1.5 pr-2"><input type="checkbox" className="h-4 w-4 accent-primary" checked={s.active} onChange={(e) => change(i, { active: e.target.checked })} aria-label={`Use ${s.code}`} /></td>
                <td className="py-1.5"><button type="button" onClick={() => { setSections((p) => p.filter((_, k) => k !== i)); setDirty(true); }} className="text-foreground-subtle hover:text-danger" aria-label={`Remove ${s.code}`}><Trash2 className="h-4 w-4" /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => { setSections((p) => [...p, { code: "", label: "", ratePct: 0, active: true }]); setDirty(true); }}><Plus className="mr-1 h-4 w-4" />Add a section</Button>
        <Button variant="ghost" size="sm" onClick={() => { setSections(TDS_DEFAULT_SECTIONS.map((s) => ({ ...s }))); setDirty(true); }}>Start from the usual sections</Button>
        <Button size="sm" className="ml-auto" disabled={!dirty || save.isPending} onClick={submit}>{save.isPending ? "Saving…" : "Save TDS"}</Button>
      </div>
    </section>
  );
}
