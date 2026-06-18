"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Settings2, Plus, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DatePicker } from "@/components/ui/date-picker";
import { useCreateStructure } from "@/features/commissions/api";
import { useUsers } from "@/features/users/api";
import type { CommissionTier } from "@delta/shared";

function today() { return new Date().toISOString().slice(0, 10); }

export default function NewStructurePage() {
  const router = useRouter();
  const { mutate, isPending } = useCreateStructure();
  const { data: usersData } = useUsers({ page: 1, pageSize: 100 });

  const [salespersonId, setSalespersonId] = useState("");
  const [type, setType] = useState<"flat" | "percentage" | "tiered">("percentage");
  const [flatAmount, setFlatAmount] = useState("");
  const [percentage, setPercentage] = useState("");
  const [tiers, setTiers] = useState<CommissionTier[]>([
    { upToMinor: 100000 * 100, percentage: 5 },
    { upToMinor: null, percentage: 8 },
  ]);
  const [basis, setBasis] = useState<"invoice_raised" | "payment_received">("invoice_raised");
  const [effectiveFrom, setEffectiveFrom] = useState(today());
  const [effectiveTo, setEffectiveTo] = useState("");
  const [notes, setNotes] = useState("");

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
    mutate(
      {
        salespersonId,
        type,
        flatAmountMinor: type === "flat" ? Math.round(parseFloat(flatAmount) * 100) : undefined,
        percentage: type === "percentage" ? parseFloat(percentage) : undefined,
        tiers: type === "tiered" ? tiers : undefined,
        basis,
        effectiveFrom,
        effectiveTo: effectiveTo || undefined,
        notes,
      },
      { onSuccess: () => router.push("/commissions/structures") },
    );
  }

  const users = usersData?.data ?? [];

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        icon={Settings2}
        title="New Commission Structure"
        description="Define a commission rate for a salesperson."
      />

      <form onSubmit={handleSubmit} className="space-y-6 max-w-2xl">
        {/* Salesperson */}
        <div className="space-y-1.5">
          <Label htmlFor="salesperson">Salesperson</Label>
          <Select value={salespersonId} onValueChange={setSalespersonId} required>
            <SelectTrigger id="salesperson">
              <SelectValue placeholder="Select salesperson…" />
            </SelectTrigger>
            <SelectContent>
              {users.map((u) => (
                <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Commission type */}
        <div className="space-y-1.5">
          <Label>Type</Label>
          <Select value={type} onValueChange={(v) => setType(v as typeof type)}>
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

        {/* Rate fields */}
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
              placeholder="500.00"
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
              placeholder="5.00"
              required
            />
          </div>
        )}

        {type === "tiered" && (
          <div className="space-y-3">
            <Label>Tiers (step method — full invoice × rate of matching bracket)</Label>
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
                      placeholder="No limit (top tier)"
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
                      required
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => removeTier(idx)}
                    className="mt-5 p-1.5 text-foreground-muted hover:text-danger"
                    disabled={tiers.length <= 1}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
            <Button type="button" variant="outline" size="sm" onClick={addTier}>
              <Plus className="h-4 w-4" /> Add Tier
            </Button>
          </div>
        )}

        {/* Trigger */}
        <div className="space-y-1.5">
          <Label>Commission Trigger</Label>
          <Select value={basis} onValueChange={(v) => setBasis(v as typeof basis)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="invoice_raised">When invoice is raised</SelectItem>
              <SelectItem value="payment_received">When payment is received</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Dates */}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Effective From</Label>
            <DatePicker value={effectiveFrom} onChange={setEffectiveFrom} />
          </div>
          <div className="space-y-1.5">
            <Label>Effective To (optional)</Label>
            <DatePicker value={effectiveTo} onChange={setEffectiveTo} placeholder="No end date" />
          </div>
        </div>

        {/* Notes */}
        <div className="space-y-1.5">
          <Label htmlFor="notes">Notes</Label>
          <textarea
            id="notes"
            className="w-full rounded-md border border-border bg-surface p-2.5 text-sm text-foreground placeholder:text-foreground-subtle focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Optional notes…"
          />
        </div>

        <div className="flex gap-3">
          <Button type="submit" disabled={isPending || !salespersonId}>
            {isPending ? "Saving…" : "Create Structure"}
          </Button>
          <Button type="button" variant="outline" onClick={() => router.back()}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
