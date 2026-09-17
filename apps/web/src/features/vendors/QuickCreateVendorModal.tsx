"use client";

import { useState } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Building2 } from "lucide-react";
import { createVendorSchema, type CreateVendorInput } from "@delta/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { CURRENCIES, useCurrency } from "@/lib/currency-context";
import { useCreateVendor } from "./api";

/**
 * A vendor, made where you noticed you needed one.
 *
 * Raising a purchase order for somebody not yet on file meant abandoning the
 * order, going to Vendors, creating them, and coming back to start again — so
 * the half-typed order was lost to a piece of filing. This is the same escape
 * the customer picker already offers on invoices and quotations.
 *
 * Deliberately the short version of the vendor form: enough to raise an order
 * against, not everything a vendor record can hold. Banking details and an
 * address are things you fill in when you have them, and stopping to find them
 * is the interruption this exists to avoid. The full form is still there.
 */
const quickSchema = createVendorSchema.pick({
  name: true,
  email: true,
  phone: true,
  companyName: true,
  currency: true,
});
type QuickValues = z.infer<typeof quickSchema>;

export function QuickCreateVendorModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string, name: string) => void;
}) {
  const { baseCurrency: orgCurrency } = useCurrency();
  const createVendor = useCreateVendor();
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<QuickValues>({
    resolver: zodResolver(quickSchema),
    defaultValues: {
      name: "",
      email: "",
      phone: "",
      companyName: "",
      currency: orgCurrency,
    },
  });

  async function submit(values: QuickValues) {
    setServerError(null);
    try {
      const vendor = await createVendor.mutateAsync(values as CreateVendorInput);
      reset();
      onCreated(vendor.id, vendor.name);
    } catch (e) {
      setServerError(e instanceof Error ? e.message : "Failed to create vendor");
    }
  }

  function handleClose() {
    reset();
    setServerError(null);
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Building2 className="h-4 w-4" />
            New Vendor
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(submit)} className="space-y-4">
          <div className="space-y-1.5">
            <Label>Name *</Label>
            <Input {...register("name")} placeholder="e.g. Gulf Stationery" autoFocus />
            {errors.name && <p className="text-xs text-danger">{errors.name.message}</p>}
          </div>
          <div className="space-y-1.5">
            <Label>Email *</Label>
            <Input {...register("email")} type="email" placeholder="accounts@supplier.com" />
            {errors.email && <p className="text-xs text-danger">{errors.email.message}</p>}
          </div>
          <div className="space-y-1.5">
            <Label>Phone *</Label>
            <Input {...register("phone")} placeholder="+971 4 000 0000" />
            {errors.phone && <p className="text-xs text-danger">{errors.phone.message}</p>}
          </div>
          <div className="space-y-1.5">
            <Label>Company</Label>
            <Input {...register("companyName")} placeholder="Registered trading name" />
            {errors.companyName && (
              <p className="text-xs text-danger">{errors.companyName.message}</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label>Currency</Label>
            <Controller
              control={control}
              name="currency"
              render={({ field }) => (
                <Select value={field.value ?? orgCurrency} onValueChange={field.onChange}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CURRENCIES.map((c) => (
                      <SelectItem key={c.code} value={c.code}>
                        {c.code} — {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>
          {serverError && <p className="text-sm text-danger">{serverError}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={handleClose}>Cancel</Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Creating…" : "Create Vendor"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
