"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useCreateItem } from "@/features/inventory/api";
import { ITEM_UNIT_LABELS, type ItemUnit } from "@delta/shared";

const UNITS = Object.keys(ITEM_UNIT_LABELS) as ItemUnit[];

const formSchema = z.object({
  name: z.string().min(1, "Name is required"),
  description: z.string().optional(),
  sku: z.string().min(1, "SKU is required"),
  type: z.enum(["product", "service"]),
  unit: z.enum(["each", "kg", "g", "liter", "ml", "meter", "cm", "box", "set", "hour", "day", "pair", "dozen", "pack"]),
  unitPriceDisplay: z.string().default("0"),
  costPriceDisplay: z.string().default("0"),
  trackStock: z.boolean().default(true),
  reorderPoint: z.coerce.number().min(0).default(0),
  reorderQty: z.coerce.number().min(0).default(0),
  photoUrl: z.string().optional(),
});
type FormValues = z.infer<typeof formSchema>;

function toMinor(v: string) { const n = parseFloat(v); return isNaN(n) ? 0 : Math.round(n * 100); }

export default function NewItemPage() {
  const router = useRouter();
  const createItem = useCreateItem();

  const { register, handleSubmit, watch, setValue, formState: { errors, isSubmitting } } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { type: "product", unit: "each", trackStock: true },
  });

  const type = watch("type");
  const trackStock = watch("trackStock");

  async function onSubmit(values: FormValues) {
    try {
      const item = await createItem.mutateAsync({
        name: values.name,
        description: values.description ?? "",
        sku: values.sku,
        type: values.type,
        unit: values.unit,
        unitPriceMinor: toMinor(values.unitPriceDisplay),
        costPriceMinor: toMinor(values.costPriceDisplay),
        trackStock: values.type === "product" ? values.trackStock : false,
        reorderPoint: values.reorderPoint,
        reorderQty: values.reorderQty,
        photoUrl: values.photoUrl || undefined,
        isActive: true,
      });
      toast.success("Item created");
      router.push(`/inventory/${item.id}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to create item");
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Link href="/inventory" className="inline-flex h-9 w-9 items-center justify-center rounded-md text-foreground-muted hover:bg-surface-muted hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div>
          <h1 className="text-xl font-semibold">New Item</h1>
          <p className="text-sm text-foreground-muted">Add a product or service to your catalog.</p>
        </div>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        {/* Basic info */}
        <div className="rounded-lg border border-border bg-surface p-6 space-y-4">
          <h2 className="text-sm font-semibold text-foreground-muted uppercase tracking-wide">Item Details</h2>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1 col-span-2">
              <Label htmlFor="name">Name *</Label>
              <Input id="name" {...register("name")} placeholder="e.g. Office Chair" />
              {errors.name && <p className="text-xs text-danger">{errors.name.message}</p>}
            </div>

            <div className="space-y-1">
              <Label htmlFor="sku">SKU *</Label>
              <Input id="sku" {...register("sku")} placeholder="e.g. CHAIR-001" />
              {errors.sku && <p className="text-xs text-danger">{errors.sku.message}</p>}
            </div>

            <div className="space-y-1">
              <Label>Type</Label>
              <Select value={type} onValueChange={(v) => setValue("type", v as "product" | "service")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="product">Product</SelectItem>
                  <SelectItem value="service">Service</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label>Unit of Measure</Label>
              <Select value={watch("unit")} onValueChange={(v) => setValue("unit", v as ItemUnit)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {UNITS.map((u) => <SelectItem key={u} value={u}>{ITEM_UNIT_LABELS[u]}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1 col-span-2">
              <Label htmlFor="description">Description</Label>
              <textarea
                id="description"
                {...register("description")}
                rows={2}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-foreground-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 resize-none"
                placeholder="Optional description…"
              />
            </div>
          </div>
        </div>

        {/* Pricing */}
        <div className="rounded-lg border border-border bg-surface p-6 space-y-4">
          <h2 className="text-sm font-semibold text-foreground-muted uppercase tracking-wide">Pricing</h2>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="unitPriceDisplay">Unit Price (AED)</Label>
              <Input id="unitPriceDisplay" type="number" step="0.01" min="0" {...register("unitPriceDisplay")} placeholder="0.00" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="costPriceDisplay">Cost Price (AED)</Label>
              <Input id="costPriceDisplay" type="number" step="0.01" min="0" {...register("costPriceDisplay")} placeholder="0.00" />
            </div>
          </div>
        </div>

        {/* Stock tracking (product only) */}
        {type === "product" && (
          <div className="rounded-lg border border-border bg-surface p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-foreground-muted uppercase tracking-wide">Stock Tracking</h2>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={trackStock}
                  onChange={(e) => setValue("trackStock", e.target.checked)}
                  className="rounded border-border"
                />
                <span className="text-sm text-foreground">Track stock</span>
              </label>
            </div>
            {trackStock && (
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <Label htmlFor="reorderPoint">Reorder Point</Label>
                  <Input id="reorderPoint" type="number" min="0" step="1" {...register("reorderPoint")} placeholder="0" />
                  <p className="text-xs text-foreground-subtle">Alert when stock falls below this</p>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="reorderQty">Reorder Quantity</Label>
                  <Input id="reorderQty" type="number" min="0" step="1" {...register("reorderQty")} placeholder="0" />
                  <p className="text-xs text-foreground-subtle">Suggested order quantity</p>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Photo */}
        <div className="rounded-lg border border-border bg-surface p-6 space-y-4">
          <h2 className="text-sm font-semibold text-foreground-muted uppercase tracking-wide">Product Photo</h2>
          <div className="space-y-1">
            <Label htmlFor="photoUrl">Photo URL</Label>
            <Input id="photoUrl" {...register("photoUrl")} placeholder="https://…" />
            <p className="text-xs text-foreground-subtle">Paste a publicly accessible image URL</p>
          </div>
          {watch("photoUrl") && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={watch("photoUrl")} alt="Preview" className="h-24 w-24 rounded-lg object-cover border border-border" />
          )}
        </div>

        <div className="flex items-center justify-end gap-3">
          <Button type="button" variant="outline" onClick={() => router.push("/inventory")}>Cancel</Button>
          <Button type="submit" disabled={isSubmitting}>{isSubmitting ? "Creating…" : "Create Item"}</Button>
        </div>
      </form>
    </div>
  );
}
