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
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useCreateWarehouse } from "@/features/inventory/api";

const formSchema = z.object({
  name: z.string().min(1, "Name is required"),
  location: z.string().optional(),
  isDefault: z.boolean().default(false),
});
type FormValues = z.infer<typeof formSchema>;

export default function NewWarehousePage() {
  const router = useRouter();
  const createWarehouse = useCreateWarehouse();

  const { register, handleSubmit, watch, setValue, formState: { errors, isSubmitting } } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { isDefault: false },
  });

  async function onSubmit(values: FormValues) {
    try {
      await createWarehouse.mutateAsync({
        name: values.name,
        location: values.location ?? "",
        isDefault: values.isDefault,
      });
      toast.success("Warehouse created");
      router.push("/inventory/warehouses");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to create warehouse");
    }
  }

  return (
    <div className="mx-auto max-w-lg space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Link href="/inventory/warehouses" className="inline-flex h-9 w-9 items-center justify-center rounded-md text-foreground-muted hover:bg-surface-muted hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div>
          <h1 className="text-xl font-semibold">Add Warehouse</h1>
          <p className="text-sm text-foreground-muted">Create a new storage location.</p>
        </div>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <div className="rounded-lg border border-border bg-surface p-6 space-y-4">
          <div className="space-y-1">
            <Label htmlFor="name">Name *</Label>
            <Input id="name" {...register("name")} placeholder="e.g. Main Warehouse" />
            {errors.name && <p className="text-xs text-danger">{errors.name.message}</p>}
          </div>
          <div className="space-y-1">
            <Label htmlFor="location">Location / Address</Label>
            <Input id="location" {...register("location")} placeholder="e.g. Dubai Industrial City, Shed 12" />
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={watch("isDefault")}
              onChange={(e) => setValue("isDefault", e.target.checked)}
              className="rounded border-border"
            />
            <span className="text-sm text-foreground">Set as default warehouse</span>
          </label>
        </div>

        <div className="flex items-center justify-end gap-3">
          <Button type="button" variant="outline" onClick={() => router.push("/inventory/warehouses")}>Cancel</Button>
          <Button type="submit" disabled={isSubmitting}>{isSubmitting ? "Creating…" : "Create Warehouse"}</Button>
        </div>
      </form>
    </div>
  );
}
