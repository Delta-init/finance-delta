"use client";

import { useState } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { UserPlus } from "lucide-react";
import { createCustomerSchema, type CreateCustomerInput } from "@delta/shared";
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
import { useCurrency } from "@/lib/currency-context";
import { useCreateCustomer } from "./api";

const quickSchema = createCustomerSchema.pick({
  name: true,
  email: true,
  phone: true,
  currency: true,
});
type QuickValues = z.infer<typeof quickSchema>;

const CURRENCIES = ["AED", "USD", "EUR", "GBP", "INR", "SAR", "QAR", "KWD"];

export function QuickCreateCustomerModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string, name: string) => void;
}) {
  const { currency: orgCurrency } = useCurrency();
  const createCustomer = useCreateCustomer();
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
      currency: orgCurrency,
    },
  });

  async function submit(values: QuickValues) {
    setServerError(null);
    try {
      const customer = await createCustomer.mutateAsync(values as CreateCustomerInput);
      reset();
      onCreated(customer.id, customer.name);
    } catch (e) {
      setServerError(e instanceof Error ? e.message : "Failed to create customer");
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
            <UserPlus className="h-4 w-4" />
            New Customer
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(submit)} className="space-y-4">
          <div className="space-y-1.5">
            <Label>Name *</Label>
            <Input {...register("name")} placeholder="e.g. Acme Corp" autoFocus />
            {errors.name && <p className="text-xs text-danger">{errors.name.message}</p>}
          </div>
          <div className="space-y-1.5">
            <Label>Email *</Label>
            <Input {...register("email")} type="email" placeholder="billing@acme.com" />
            {errors.email && <p className="text-xs text-danger">{errors.email.message}</p>}
          </div>
          <div className="space-y-1.5">
            <Label>Phone *</Label>
            <Input {...register("phone")} placeholder="+971 50 000 0000" />
            {errors.phone && <p className="text-xs text-danger">{errors.phone.message}</p>}
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
                      <SelectItem key={c} value={c}>{c}</SelectItem>
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
              {isSubmitting ? "Creating…" : "Create Customer"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
