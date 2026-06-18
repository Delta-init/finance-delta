"use client";

import { useState, useEffect } from "react";
import { useRouter, useParams } from "next/navigation";
import { Settings2, Lock, Unlock, Plus, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DatePicker } from "@/components/ui/date-picker";
import {
  useCommissionStructure,
  useUpdateStructure,
  useLockStructure,
} from "@/features/commissions/api";
import type { CommissionTier } from "@delta/shared";

export default function EditStructurePage() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();

  const { data: structure, isLoading } = useCommissionStructure(id);
  const { mutate: update, isPending: saving } = useUpdateStructure();
  const { mutate: toggleLock, isPending: locking } = useLockStructure();

  const [type, setType] = useState<"flat" | "percentage" | "tiered">("percentage");
  const [flatAmount, setFlatAmount] = useState("");
  const [percentage, setPercentage] = useState("");
  const [tiers, setTiers] = useState<CommissionTier[]>([]);
  const [basis, setBasis] = useState<"invoice_raised" | "payment_received">("invoice_raised");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [effectiveTo, setEffectiveTo] = useState("");
  const [notes, setNotes] = useState("");
  const [isActive, setIsActive] = useState(true);

  useEffect(() => {
    if (!structure) return;
    setType(structure.type);
    setFlatAmount(structure.flatAmountMinor ? (structure.flatAmountMinor / 100).toFixed(2) : "");
    setPercentage(structure.percentage ? String(structure.percentage) : "");
    setTiers(structure.tiers ?? []);
    setBasis(structure.basis);
    setEffectiveFrom(structure.effectiveFrom);
    setEffectiveTo(structure.effectiveTo ?? "");
    setNotes(structure.notes);
    setIsActive(structure.isActive);
  }, [structure]);

  function addTier() {
    setTiers((prev) => [...prev, { upToMinor: null, percentage: 0 }]);
  }

  function removeTier(idx: number) {
    setTiers((prev) => prev.filter((_, i) => i !== idx));
  }

  function updateTier(idx: number, field: "upToMinor" | "percentage", raw: string) {
    setTiers((prev) =>
      prev.map((t, i) => {
        if (i !== idx) return t;
        if (field === "upToMinor") {
          const val = raw === "" ? null : Math.round(parseFloat(raw) * 100);
          return { ...t, upToMinor: val };
        }
        return { ...t, percentage: parseFloat(raw) || 0 };
      }),
    );
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    update(
      {
        id,
        input: {
          type,
          flatAmountMinor: type === "flat" ? Math.round(parseFloat(flatAmount) * 100) : undefined,
          percentage: type === "percentage" ? parseFloat(percentage) : undefined,
          tiers: type === "tiered" ? tiers : undefined,
          basis,
          effectiveFrom,
          effectiveTo: effectiveTo || undefined,
          notes,
          isActive,
        },
      },
      { onSuccess: () => router.push("/commissions/structures") },
    );
  }

  if (isLoading) {
    return (
      <div className="p-6 space-y-4">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="h-10 animate-pulse rounded bg-surface-muted" />
        ))}
      </div>
    );
  }

  if (!structure) return null;

  const locked = structure.isLocked;

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        icon={Settings2}
        title={`${structure.salespersonName} — Structure`}
        description="Edit commission rates, trigger, and effective dates."
        action={
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => toggleLock({ id, lock: !locked })}
              disabled={locking}
            >
              {locked ? (
                <><Unlock className="h-4 w-4" /> Unlock</>
              ) : (
                <><Lock className="h-4 w-4" /> Lock</>
              )}
            </Button>
          </div>
        }
      />

      {locked && (
        <div className="flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-sm text-warning">
          <Lock className="h-4 w-4 shrink-0" />
          <span>
            Locked by {structure.lockedByName ?? "admin"} on{" "}
            {structure.lockedAt ? new Date(structure.lockedAt).toLocaleDateString() : "—"}.
            Only users with <strong>commission:approve</strong> can edit.
          </span>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6 max-w-2xl">
        {/* Status toggle */}
        <div className="flex items-center gap-3 rounded-lg border border-border bg-surface p-4">
          <button
            type="button"
            role="switch"
            aria-checked={isActive}
            onClick={() => setIsActive((v) => !v)}
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 ${
              isActive ? "bg-primary" : "bg-surface-muted"
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
                isActive ? "translate-x-4" : "translate-x-0"
              }`}
            />
          </button>
          <span className="text-sm font-medium">{isActive ? "Active" : "Inactive"}</span>
          <Badge tone={isActive ? "success" : "neutral"} className="ml-auto">
            {isActive ? "Will calculate commissions" : "Paused"}
          </Badge>
        </div>

        {/* Type */}
        <div className="space-y-1.5">
          <Label>Type</Label>
          <Select value={type} onValueChange={(v) => setType(v as typeof type)} disabled={locked}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="flat">Flat amount per invoice</SelectItem>
              <SelectItem value="percentage">Percentage of invoice total</SelectItem>
              <SelectItem value="tiered">Tiered (step method)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {type === "flat" && (
          <div className="space-y-1.5">
            <Label htmlFor="flatAmount">Flat Amount (AED)</Label>
            <Input
              id="flatAmount"
              type="number"
              step="0.01"
              min="0"
              value={flatAmount}
              onChange={(e) => setFlatAmount(e.target.value)}
              disabled={locked}
              required
            />
          </div>
        )}

        {type === "percentage" && (
          <div className="space-y-1.5">
            <Label htmlFor="pct">Commission %</Label>
            <Input
              id="pct"
              type="number"
              step="0.01"
              min="0"
              max="100"
              value={percentage}
              onChange={(e) => setPercentage(e.target.value)}
              disabled={locked}
              required
            />
          </div>
        )}

        {type === "tiered" && (
          <div className="space-y-3">
            <Label>Tiers</Label>
            <div className="space-y-2">
              {tiers.map((tier, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <div className="flex-1 space-y-1">
                    <p className="text-xs text-foreground-muted">Up to (AED)</p>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      value={tier.upToMinor !== null ? (tier.upToMinor / 100).toFixed(2) : ""}
                      onChange={(e) => updateTier(idx, "upToMinor", e.target.value)}
                      placeholder="No limit"
                      disabled={locked}
                    />
                  </div>
                  <div className="w-32 space-y-1">
                    <p className="text-xs text-foreground-muted">Rate %</p>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      max="100"
                      value={tier.percentage}
                      onChange={(e) => updateTier(idx, "percentage", e.target.value)}
                      disabled={locked}
                      required
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => removeTier(idx)}
                    className="mt-5 p-1.5 text-foreground-muted hover:text-danger"
                    disabled={tiers.length <= 1 || locked}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
            {!locked && (
              <Button type="button" variant="outline" size="sm" onClick={addTier}>
                <Plus className="h-4 w-4" /> Add Tier
              </Button>
            )}
          </div>
        )}

        <div className="space-y-1.5">
          <Label>Trigger</Label>
          <Select value={basis} onValueChange={(v) => setBasis(v as typeof basis)} disabled={locked}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="invoice_raised">When invoice is raised</SelectItem>
              <SelectItem value="payment_received">When payment is received</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Effective From</Label>
            <DatePicker value={effectiveFrom} onChange={locked ? () => {} : setEffectiveFrom} />
          </div>
          <div className="space-y-1.5">
            <Label>Effective To (optional)</Label>
            <DatePicker value={effectiveTo} onChange={locked ? () => {} : setEffectiveTo} placeholder="No end date" />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="notes">Notes</Label>
          <textarea
            id="notes"
            className="w-full rounded-md border border-border bg-surface p-2.5 text-sm text-foreground placeholder:text-foreground-subtle focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-60"
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            disabled={locked}
          />
        </div>

        <div className="flex gap-3">
          <Button type="submit" disabled={saving || locked}>
            {saving ? "Saving…" : "Save Changes"}
          </Button>
          <Button type="button" variant="outline" onClick={() => router.back()}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
