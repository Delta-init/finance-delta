"use client";

import { use } from "react";
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
import { useBankAccount, useCreateBankTransaction } from "@/features/banking/api";

const formSchema = z.object({
  date: z.string().min(1, "Date is required"),
  description: z.string().min(1, "Description is required"),
  reference: z.string().optional(),
  amountDisplay: z.string().min(1, "Amount is required"),
  type: z.enum(["credit", "debit"]),
  notes: z.string().optional(),
});
type FormValues = z.infer<typeof formSchema>;

function toMinor(val: string): number {
  const n = parseFloat(val);
  return isNaN(n) ? 0 : Math.round(n * 100);
}

export default function NewTransactionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { data: account } = useBankAccount(id);
  const createTx = useCreateBankTransaction(id);
  const today = new Date().toISOString().slice(0, 10);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { date: today, type: "credit" },
  });

  async function onSubmit(values: FormValues) {
    try {
      const amt = toMinor(values.amountDisplay);
      await createTx.mutateAsync({
        date: values.date,
        description: values.description,
        reference: values.reference ?? "",
        amountMinor: values.type === "credit" ? amt : -amt,
        notes: values.notes ?? "",
      });
      toast.success("Transaction added");
      router.push(`/banking/${id}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to add transaction");
    }
  }

  const type = watch("type");

  return (
    <div className="mx-auto max-w-xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Link
          href={`/banking/${id}`}
          className="inline-flex h-9 w-9 items-center justify-center rounded-md text-foreground-muted hover:bg-surface-muted hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div>
          <h1 className="text-xl font-semibold">Add Transaction</h1>
          <p className="text-sm text-foreground-muted">
            {account ? `${account.accountName} · ${account.currency}` : "Loading…"}
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <div className="rounded-lg border border-border bg-surface p-6 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="date">Date *</Label>
              <Input id="date" type="date" {...register("date")} />
              {errors.date && <p className="text-xs text-danger">{errors.date.message}</p>}
            </div>

            <div className="space-y-1">
              <Label>Type</Label>
              <div className="flex rounded-md border border-border overflow-hidden">
                {(["credit", "debit"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setValue("type", t)}
                    className={`flex-1 py-2 text-sm font-medium transition-colors ${
                      type === t
                        ? t === "credit"
                          ? "bg-success text-white"
                          : "bg-danger text-white"
                        : "bg-background text-foreground-muted hover:bg-surface-muted"
                    }`}
                  >
                    {t.charAt(0).toUpperCase() + t.slice(1)}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="description">Description *</Label>
            <Input id="description" {...register("description")} placeholder="Transaction description" />
            {errors.description && <p className="text-xs text-danger">{errors.description.message}</p>}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="amountDisplay">
                Amount ({account?.currency ?? "AED"}) *
              </Label>
              <Input
                id="amountDisplay"
                type="number"
                step="0.01"
                min="0"
                {...register("amountDisplay")}
                placeholder="0.00"
              />
              {errors.amountDisplay && <p className="text-xs text-danger">{errors.amountDisplay.message}</p>}
            </div>
            <div className="space-y-1">
              <Label htmlFor="reference">Reference</Label>
              <Input id="reference" {...register("reference")} placeholder="Cheque #, PO #, etc." />
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="notes">Notes</Label>
            <textarea
              id="notes"
              {...register("notes")}
              rows={2}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-foreground-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 resize-none"
              placeholder="Optional notes…"
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-3">
          <Button type="button" variant="outline" onClick={() => router.push(`/banking/${id}`)}>
            Cancel
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Adding…" : "Add Transaction"}
          </Button>
        </div>
      </form>
    </div>
  );
}
