"use client";

import { use } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { ADJUSTMENT_REASON_LABELS, ITEM_UNIT_LABELS, type ItemUnit, type AdjustmentReason } from "@delta/shared";
import { useItem, useStockLevels, useWarehouses, useAdjustStock } from "@/features/inventory/api";

const REASONS = Object.keys(ADJUSTMENT_REASON_LABELS) as AdjustmentReason[];

const formSchema = z.object({
  warehouseId: z.string().min(1, "Warehouse is required"),
  newQuantity: z.coerce.number().min(0, "Quantity cannot be negative"),
  reason: z.enum(["shrinkage", "damage", "write_off", "found", "correction", "opening_stock", "other"]),
  notes: z.string().optional(),
  movementDate: z.string().optional(),
});
type FormValues = z.infer<typeof formSchema>;

export default function AdjustStockPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { data: item } = useItem(id);
  const { data: stockLevels } = useStockLevels(id);
  const { data: warehousesData } = useWarehouses({ pageSize: 100, isActive: "true" });
  const adjustStock = useAdjustStock(id);

  const { register, handleSubmit, watch, control, formState: { errors, isSubmitting } } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { reason: "correction", newQuantity: 0 },
  });

  const warehouseId = watch("warehouseId");
  const currentStock = stockLevels?.find((sl) => sl.warehouseId === warehouseId);

  async function onSubmit(values: FormValues) {
    try {
      await adjustStock.mutateAsync({
        warehouseId: values.warehouseId,
        newQuantity: values.newQuantity,
        reason: values.reason,
        notes: values.notes ?? "",
        movementDate: values.movementDate || undefined,
      });
      toast.success("Stock adjusted");
      router.push(`/inventory/${id}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to adjust stock");
    }
  }

  const unit = item ? (ITEM_UNIT_LABELS[item.unit as ItemUnit] ?? item.unit) : "";

  return (
    <div className="mx-auto max-w-lg space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Link
          href={`/inventory/${id}`}
          className="inline-flex h-9 w-9 items-center justify-center rounded-md text-foreground-muted hover:bg-surface-muted hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div>
          <h1 className="text-xl font-semibold">Adjust Stock</h1>
          <p className="text-sm text-foreground-muted">{item?.name ?? "…"}</p>
        </div>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <div className="rounded-lg border border-border bg-surface p-6 space-y-4">
          {/* Warehouse */}
          <div className="space-y-1">
            <Label>Warehouse *</Label>
            <Controller
              control={control}
              name="warehouseId"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select warehouse…" />
                  </SelectTrigger>
                  <SelectContent>
                    {warehousesData?.data?.map((w) => (
                      <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            {errors.warehouseId && <p className="text-xs text-danger">{errors.warehouseId.message}</p>}
          </div>

          {/* Current stock indicator */}
          {warehouseId && (
            <div className="rounded-md bg-surface-muted px-3 py-2 text-sm">
              <span className="text-foreground-muted">Current stock: </span>
              <span className="font-semibold text-foreground">
                {currentStock?.quantityOnHand ?? 0} {unit}
              </span>
            </div>
          )}

          {/* New quantity */}
          <div className="space-y-1">
            <Label htmlFor="newQuantity">New Quantity ({unit}) *</Label>
            <Input
              id="newQuantity"
              type="number"
              min="0"
              step="0.001"
              {...register("newQuantity")}
              placeholder="0"
            />
            {errors.newQuantity && <p className="text-xs text-danger">{errors.newQuantity.message}</p>}
          </div>

          {/* Reason */}
          <div className="space-y-1">
            <Label>Reason *</Label>
            <Controller
              control={control}
              name="reason"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {REASONS.map((r) => (
                      <SelectItem key={r} value={r}>{ADJUSTMENT_REASON_LABELS[r]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>

          {/* Date */}
          <div className="space-y-1">
            <Label htmlFor="movementDate">Date</Label>
            <Input
              id="movementDate"
              type="date"
              {...register("movementDate")}
            />
          </div>

          {/* Notes */}
          <div className="space-y-1">
            <Label htmlFor="notes">Notes</Label>
            <textarea
              id="notes"
              {...register("notes")}
              rows={2}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-foreground-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 resize-none"
              placeholder="Optional notes about this adjustment…"
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-3">
          <Button type="button" variant="outline" onClick={() => router.push(`/inventory/${id}`)}>
            Cancel
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Saving…" : "Save Adjustment"}
          </Button>
        </div>
      </form>
    </div>
  );
}
