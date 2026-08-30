"use client";

import { useEffect } from "react";
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
import { useCreateBankAccount } from "@/features/banking/api";
import { BANK_ACCOUNT_TYPE_LABELS, type BankAccountType } from "@delta/shared";
import { useCurrency } from "@/lib/currency-context";

const ACCOUNT_TYPES = Object.keys(BANK_ACCOUNT_TYPE_LABELS) as BankAccountType[];

const CURRENCIES = ["AED", "USD", "EUR", "GBP", "INR", "SAR", "QAR", "KWD", "BHD", "OMR"];

const formSchema = z.object({
  accountName: z.string().min(1, "Account name is required"),
  accountNumber: z.string().optional(),
  bankName: z.string().optional(),
  branch: z.string().optional(),
  ifsc: z.string().optional(),
  swift: z.string().optional(),
  iban: z.string().optional(),
  accountType: z.enum(["current", "savings", "petty_cash", "internal"]),
  currency: z.string().min(3).max(3),
  openingBalanceDisplay: z.string().default("0"),
  openingDate: z.string().min(1, "Opening date is required"),
  notes: z.string().optional(),
});
type FormValues = z.infer<typeof formSchema>;

function toMinor(val: string): number {
  const n = parseFloat(val);
  return isNaN(n) ? 0 : Math.round(n * 100);
}

export default function NewBankAccountPage() {
  const router = useRouter();
  const createAccount = useCreateBankAccount();
  const { currency: orgCurrency } = useCurrency();
  const today = new Date().toISOString().slice(0, 10);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      accountType: "current",
      currency: orgCurrency,
      openingBalanceDisplay: "0",
      openingDate: today,
    },
  });

  useEffect(() => {
    setValue("currency", orgCurrency, { shouldDirty: false });
  }, [orgCurrency]); // eslint-disable-line react-hooks/exhaustive-deps

  async function onSubmit(values: FormValues) {
    try {
      const account = await createAccount.mutateAsync({
        accountName: values.accountName,
        accountNumber: values.accountNumber ?? "",
        bankName: values.bankName ?? "",
        branch: values.branch ?? "",
        ifsc: values.ifsc ?? "",
        swift: values.swift ?? "",
        iban: values.iban ?? "",
        accountType: values.accountType,
        currency: values.currency,
        openingBalanceMinor: toMinor(values.openingBalanceDisplay),
        openingDate: values.openingDate,
        notes: values.notes ?? "",
      });
      toast.success("Bank account created");
      router.push(`/banking/${account.id}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to create account");
    }
  }

  const currency = watch("currency");

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Link
          href="/banking"
          className="inline-flex h-9 w-9 items-center justify-center rounded-md text-foreground-muted hover:bg-surface-muted hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div>
          <h1 className="text-xl font-semibold">Add Bank Account</h1>
          <p className="text-sm text-foreground-muted">Connect a new bank account to track transactions.</p>
        </div>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        {/* Account Details */}
        <div className="rounded-lg border border-border bg-surface p-6 space-y-4">
          <h2 className="text-sm font-semibold text-foreground-muted uppercase tracking-wide">Account Details</h2>

          <div className="space-y-1">
            <Label htmlFor="accountName">Account Name *</Label>
            <Input id="accountName" {...register("accountName")} placeholder="e.g. Main Operating Account" />
            {errors.accountName && <p className="text-xs text-danger">{errors.accountName.message}</p>}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="bankName">Bank Name</Label>
              <Input id="bankName" {...register("bankName")} placeholder="e.g. Emirates NBD" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="accountNumber">Account Number</Label>
              <Input id="accountNumber" {...register("accountNumber")} placeholder="Optional" />
            </div>
          </div>

          {/* What a client needs in order to actually pay this account. Which
              of these applies depends on where it is held, so none is required
              and the invoice prints only the ones filled in. */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="branch">Branch</Label>
              <Input id="branch" {...register("branch")} placeholder="Optional" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ifsc">IFSC</Label>
              <Input id="ifsc" {...register("ifsc")} placeholder="Indian accounts" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="swift">SWIFT / BIC</Label>
              <Input id="swift" {...register("swift")} placeholder="International transfers" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="iban">IBAN</Label>
              <Input id="iban" {...register("iban")} placeholder="UAE and European accounts" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>Account Type *</Label>
              <Select
                value={watch("accountType")}
                onValueChange={(v) => setValue("accountType", v as BankAccountType)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ACCOUNT_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {BANK_ACCOUNT_TYPE_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Currency *</Label>
              <Select key={currency} value={currency} onValueChange={(v) => setValue("currency", v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        {/* Opening Balance */}
        <div className="rounded-lg border border-border bg-surface p-6 space-y-4">
          <h2 className="text-sm font-semibold text-foreground-muted uppercase tracking-wide">Opening Balance</h2>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="openingDate">Opening Date *</Label>
              <Input id="openingDate" type="date" {...register("openingDate")} />
              {errors.openingDate && <p className="text-xs text-danger">{errors.openingDate.message}</p>}
            </div>
            <div className="space-y-1">
              <Label htmlFor="openingBalanceDisplay">Opening Balance ({currency})</Label>
              <Input
                id="openingBalanceDisplay"
                type="number"
                step="0.01"
                {...register("openingBalanceDisplay")}
                placeholder="0.00"
              />
            </div>
          </div>
        </div>

        {/* Notes */}
        <div className="rounded-lg border border-border bg-surface p-6 space-y-4">
          <h2 className="text-sm font-semibold text-foreground-muted uppercase tracking-wide">Notes</h2>
          <div className="space-y-1">
            <Label htmlFor="notes">Internal Notes</Label>
            <textarea
              id="notes"
              {...register("notes")}
              rows={3}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-foreground-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 resize-none"
              placeholder="Optional notes about this account…"
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-3">
          <Button type="button" variant="outline" onClick={() => router.push("/banking")}>
            Cancel
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Creating…" : "Create Account"}
          </Button>
        </div>
      </form>
    </div>
  );
}
