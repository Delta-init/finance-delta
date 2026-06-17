"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useWarehouse, useUpdateWarehouse } from "@/features/inventory/api";

export default function WarehouseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { data: warehouse, isLoading } = useWarehouse(id);
  const updateWarehouse = useUpdateWarehouse(id);

  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [saving, setSaving] = useState(false);
  const [initialized, setInitialized] = useState(false);

  if (warehouse && !initialized) {
    setName(warehouse.name);
    setLocation(warehouse.location ?? "");
    setIsDefault(warehouse.isDefault);
    setInitialized(true);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }
    setSaving(true);
    try {
      await updateWarehouse.mutateAsync({ name: name.trim(), location: location.trim(), isDefault });
      toast.success("Warehouse updated");
      router.push("/inventory/warehouses");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to update warehouse");
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleActive() {
    if (!warehouse) return;
    try {
      await updateWarehouse.mutateAsync({ isActive: !warehouse.isActive });
      toast.success(warehouse.isActive ? "Warehouse deactivated" : "Warehouse activated");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to update warehouse");
    }
  }

  if (isLoading) return <div className="p-6 text-foreground-muted">Loading…</div>;
  if (!warehouse) return <div className="p-6 text-foreground-muted">Warehouse not found.</div>;

  return (
    <div className="mx-auto max-w-lg space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Link
          href="/inventory/warehouses"
          className="inline-flex h-9 w-9 items-center justify-center rounded-md text-foreground-muted hover:bg-surface-muted hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold">{warehouse.name}</h1>
            {warehouse.isDefault && <Badge tone="primary">Default</Badge>}
            <Badge tone={warehouse.isActive ? "success" : "neutral"}>
              {warehouse.isActive ? "Active" : "Inactive"}
            </Badge>
          </div>
          {warehouse.location && (
            <p className="text-sm text-foreground-muted flex items-center gap-1 mt-0.5">
              <MapPin className="h-3 w-3" /> {warehouse.location}
            </p>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={handleToggleActive}>
          {warehouse.isActive ? "Deactivate" : "Activate"}
        </Button>
      </div>

      <form onSubmit={handleSave} className="space-y-6">
        <div className="rounded-lg border border-border bg-surface p-6 space-y-4">
          <div className="space-y-1">
            <Label htmlFor="name">Name *</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Main Warehouse"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="location">Location / Address</Label>
            <Input
              id="location"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="e.g. Dubai Industrial City, Shed 12"
            />
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
              className="rounded border-border"
            />
            <span className="text-sm text-foreground">Set as default warehouse</span>
          </label>
        </div>

        <div className="flex items-center justify-end gap-3">
          <Button type="button" variant="outline" onClick={() => router.push("/inventory/warehouses")}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save Changes"}
          </Button>
        </div>
      </form>
    </div>
  );
}
