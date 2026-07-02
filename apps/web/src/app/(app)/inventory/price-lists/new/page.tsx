"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MoneyDisplay } from "@/components/ui/money";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { type PriceListEntry, ITEM_UNIT_LABELS, type ItemUnit } from "@delta/shared";
import { useItems, useCreatePriceList } from "@/features/inventory/api";
import { useCurrency } from "@/lib/currency-context";

const CURRENCIES = ["AED", "USD", "EUR", "GBP", "INR", "SAR"];

interface EntryRow extends PriceListEntry {
  _rowId: string;
}

export default function NewPriceListPage() {
  const router = useRouter();
  const createPriceList = useCreatePriceList();
  const { data: itemsData } = useItems({ pageSize: 500, isActive: "true", type: "product" });
  const items = itemsData?.data ?? [];
  const { currency: orgCurrency } = useCurrency();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [currency, setCurrency] = useState<string>(orgCurrency);
  const [validFrom, setValidFrom] = useState("");
  const [validTo, setValidTo] = useState("");
  const [entries, setEntries] = useState<EntryRow[]>([]);
  const [submitting, setSubmitting] = useState(false);

  function addEntry() {
    const first = items[0];
    if (!first) { toast.error("No items available"); return; }
    setEntries((prev) => [
      ...prev,
      {
        _rowId: Math.random().toString(36).slice(2),
        itemId: first.id,
        itemName: first.name,
        sku: first.sku,
        unitPriceMinor: first.unitPriceMinor,
        discountPct: 0,
        markupPct: 0,
      },
    ]);
  }

  function updateEntry(rowId: string, patch: Partial<EntryRow>) {
    setEntries((prev) =>
      prev.map((e) => {
        if (e._rowId !== rowId) return e;
        const next = { ...e, ...patch };
        if (patch.itemId) {
          const item = items.find((i) => i.id === patch.itemId);
          if (item) {
            next.itemName = item.name;
            next.sku = item.sku;
            next.unitPriceMinor = item.unitPriceMinor;
          }
        }
        return next;
      }),
    );
  }

  function removeEntry(rowId: string) {
    setEntries((prev) => prev.filter((e) => e._rowId !== rowId));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { toast.error("Name is required"); return; }
    setSubmitting(true);
    try {
      const pl = await createPriceList.mutateAsync({
        name: name.trim(),
        description: description.trim(),
        isDefault,
        currency,
        validFrom: validFrom || undefined,
        validTo: validTo || undefined,
        entries: entries.map(({ _rowId, ...rest }) => rest),
      });
      toast.success("Price list created");
      router.push(`/inventory/price-lists/${pl.id}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to create price list");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Link
          href="/inventory/price-lists"
          className="inline-flex h-9 w-9 items-center justify-center rounded-md text-foreground-muted hover:bg-surface-muted hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div>
          <h1 className="text-xl font-semibold">New Price List</h1>
          <p className="text-sm text-foreground-muted">Create custom pricing for a customer group.</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Basic info */}
        <div className="rounded-lg border border-border bg-surface p-6 space-y-4">
          <h2 className="text-sm font-semibold text-foreground-muted uppercase tracking-wide">Details</h2>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1 col-span-2">
              <Label htmlFor="name">Name *</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Wholesale Pricing"
              />
            </div>

            <div className="space-y-1 col-span-2">
              <Label htmlFor="description">Description</Label>
              <Input
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional description…"
              />
            </div>

            <div className="space-y-1">
              <Label>Currency</Label>
              <Select value={currency} onValueChange={setCurrency}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1 flex items-end">
              <label className="flex items-center gap-2 cursor-pointer mb-2">
                <input
                  type="checkbox"
                  checked={isDefault}
                  onChange={(e) => setIsDefault(e.target.checked)}
                  className="rounded border-border"
                />
                <span className="text-sm text-foreground">Set as default price list</span>
              </label>
            </div>

            <div className="space-y-1">
              <Label htmlFor="validFrom">Valid From</Label>
              <Input id="validFrom" type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="validTo">Valid To</Label>
              <Input id="validTo" type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} />
            </div>
          </div>
        </div>

        {/* Entries */}
        <div className="rounded-lg border border-border bg-surface p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground-muted uppercase tracking-wide">Item Prices</h2>
            <Button type="button" variant="outline" size="sm" onClick={addEntry}>
              <Plus className="h-3.5 w-3.5" /> Add Item
            </Button>
          </div>

          {entries.length === 0 ? (
            <p className="text-sm text-foreground-muted">
              No items added yet. Click "Add Item" to set custom prices.
            </p>
          ) : (
            <div className="space-y-3">
              {/* Header */}
              <div className="grid grid-cols-[1fr_100px_90px_90px_36px] gap-2 text-xs font-medium text-foreground-muted uppercase tracking-wide">
                <span>Item</span>
                <span className="text-right">Base Price</span>
                <span className="text-right">Discount %</span>
                <span className="text-right">Markup %</span>
                <span />
              </div>

              {entries.map((entry) => {
                const item = items.find((i) => i.id === entry.itemId);
                return (
                  <div key={entry._rowId} className="grid grid-cols-[1fr_100px_90px_90px_36px] gap-2 items-center">
                    <Select
                      value={entry.itemId}
                      onValueChange={(v) => updateEntry(entry._rowId, { itemId: v })}
                    >
                      <SelectTrigger className="h-8 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {items.map((i) => (
                          <SelectItem key={i.id} value={i.id}>
                            {i.name} <span className="text-foreground-muted">· {i.sku}</span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

                    <div className="text-right">
                      <MoneyDisplay minor={entry.unitPriceMinor} currency={currency} className="text-sm text-foreground-muted" />
                      {item && (
                        <p className="text-[10px] text-foreground-subtle">
                          {ITEM_UNIT_LABELS[item.unit as ItemUnit] ?? item.unit}
                        </p>
                      )}
                    </div>

                    <Input
                      type="number"
                      min="0"
                      max="100"
                      step="0.1"
                      value={entry.discountPct}
                      onChange={(e) => updateEntry(entry._rowId, { discountPct: parseFloat(e.target.value) || 0 })}
                      className="h-8 text-sm text-right"
                    />

                    <Input
                      type="number"
                      min="0"
                      step="0.1"
                      value={entry.markupPct}
                      onChange={(e) => updateEntry(entry._rowId, { markupPct: parseFloat(e.target.value) || 0 })}
                      className="h-8 text-sm text-right"
                    />

                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => removeEntry(entry._rowId)}
                      className="h-8 w-8 p-0 text-danger hover:text-danger"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3">
          <Button type="button" variant="outline" onClick={() => router.push("/inventory/price-lists")}>
            Cancel
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? "Creating…" : "Create Price List"}
          </Button>
        </div>
      </form>
    </div>
  );
}
