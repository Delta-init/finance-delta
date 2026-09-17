"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Plus, Trash2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MoneyDisplay } from "@/components/ui/money";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { type PriceListEntry, ITEM_UNIT_LABELS, type ItemUnit } from "@delta/shared";
import { useItems, usePriceList, useUpdatePriceList, useDeletePriceList } from "@/features/inventory/api";
import { useCurrency } from "@/lib/currency-context";

const CURRENCIES = ["AED", "USD", "EUR", "GBP", "INR", "SAR"];

interface EntryRow extends PriceListEntry {
  _rowId: string;
}

export default function PriceListDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { data: priceList, isLoading } = usePriceList(id);
  const updatePriceList = useUpdatePriceList(id);
  const deletePriceList = useDeletePriceList();
  const { data: itemsData } = useItems({ pageSize: 500, isActive: "true", type: "product" });
  const items = itemsData?.data ?? [];

  const { baseCurrency: orgCurrency } = useCurrency();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [currency, setCurrency] = useState<string>(orgCurrency);
  const [validFrom, setValidFrom] = useState("");
  const [validTo, setValidTo] = useState("");
  const [entries, setEntries] = useState<EntryRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [initialized, setInitialized] = useState(false);

  if (priceList && !initialized) {
    setName(priceList.name);
    setDescription(priceList.description ?? "");
    setIsDefault(priceList.isDefault);
    setCurrency(priceList.currency);
    setValidFrom(priceList.validFrom?.slice(0, 10) ?? "");
    setValidTo(priceList.validTo?.slice(0, 10) ?? "");
    setEntries(
      priceList.entries.map((e) => ({ ...e, _rowId: Math.random().toString(36).slice(2) })),
    );
    setInitialized(true);
  }

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

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { toast.error("Name is required"); return; }
    setSaving(true);
    try {
      await updatePriceList.mutateAsync({
        name: name.trim(),
        description: description.trim(),
        isDefault,
        currency,
        validFrom: validFrom || undefined,
        validTo: validTo || undefined,
        entries: entries.map(({ _rowId, ...rest }) => rest),
      });
      toast.success("Price list updated");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to update price list");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!confirm("Delete this price list? This cannot be undone.")) return;
    try {
      await deletePriceList.mutateAsync(id);
      toast.success("Price list deleted");
      router.push("/inventory/price-lists");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to delete");
    }
  }

  if (isLoading) return <div className="p-6 text-foreground-muted">Loading…</div>;
  if (!priceList) return <div className="p-6 text-foreground-muted">Price list not found.</div>;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Link
          href="/inventory/price-lists"
          className="inline-flex h-9 w-9 items-center justify-center rounded-md text-foreground-muted hover:bg-surface-muted hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold">{priceList.name}</h1>
            {priceList.isDefault && <Badge tone="primary">Default</Badge>}
          </div>
          <p className="text-sm text-foreground-muted">{priceList.currency} · {priceList.entries.length} items</p>
        </div>
        <Button variant="destructive" size="sm" onClick={handleDelete}>
          <Trash2 className="h-4 w-4" /> Delete
        </Button>
      </div>

      <form onSubmit={handleSave} className="space-y-6">
        {/* Basic info */}
        <div className="rounded-lg border border-border bg-surface p-6 space-y-4">
          <h2 className="text-sm font-semibold text-foreground-muted uppercase tracking-wide">Details</h2>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1 col-span-2">
              <Label htmlFor="name">Name *</Label>
              <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>

            <div className="space-y-1 col-span-2">
              <Label htmlFor="description">Description</Label>
              <Input id="description" value={description} onChange={(e) => setDescription(e.target.value)} />
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
            <p className="text-sm text-foreground-muted">No items. Add one above.</p>
          ) : (
            <div className="space-y-3">
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
                            {i.name}
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
          <Button type="submit" disabled={saving}>
            <Save className="h-4 w-4" />
            {saving ? "Saving…" : "Save Changes"}
          </Button>
        </div>
      </form>
    </div>
  );
}
