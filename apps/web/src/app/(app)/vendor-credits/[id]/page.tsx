"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ArrowLeft, Building2, CheckCircle, Ban, Tag } from "lucide-react";
import { formatMoney } from "@delta/shared";
import type { ApplyVendorCreditInput } from "@delta/shared";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { MoneyDisplay } from "@/components/ui/money";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useVendorCredit, useIssueVendorCredit, useApplyVendorCredit, useVoidVendorCredit } from "@/features/vendor-credits/api";
import { useBills } from "@/features/bills/api";

const STATUS_TONE: Record<string, NonNullable<BadgeProps["tone"]>> = {
  draft: "neutral", issued: "primary", applied: "success", voided: "neutral",
};

const applySchema = z.object({
  targetBillId: z.string().min(1, "Select a bill"),
  amountDisplay: z.string().min(1, "Enter amount"),
});
type ApplyFormValues = z.infer<typeof applySchema>;

function toMinorFromInput(val: string): number {
  const n = parseFloat(val);
  return isNaN(n) ? 0 : Math.round(n * 100);
}

export default function VendorCreditDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { data: credit, isLoading } = useVendorCredit(id);
  const issueCredit = useIssueVendorCredit(id);
  const applyCredit = useApplyVendorCredit(id);
  const voidCredit = useVoidVendorCredit(id);
  const [applyOpen, setApplyOpen] = useState(false);

  const { data: billData } = useBills(
    credit?.vendorId
      ? { vendorId: credit.vendorId, limit: "100", sort: "dueDate", dir: "asc" }
      : { limit: "0" },
  );
  const openBills = (billData?.data ?? []).filter((b) => b.balanceMinor > 0 && b.status !== "voided");

  const { register, handleSubmit, watch, setValue, reset, formState: { errors, isSubmitting } } =
    useForm<ApplyFormValues>({ resolver: zodResolver(applySchema), defaultValues: { targetBillId: "", amountDisplay: "" } });

  async function handleAction(action: () => Promise<unknown>, msg: string) {
    try {
      await action();
      toast.success(msg);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Action failed");
    }
  }

  async function onApplySubmit(values: ApplyFormValues) {
    const input: ApplyVendorCreditInput = {
      targetBillId: values.targetBillId,
      amountMinor: toMinorFromInput(values.amountDisplay),
    };
    try {
      await applyCredit.mutateAsync(input);
      toast.success("Credit applied to bill");
      setApplyOpen(false);
      reset();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to apply credit");
    }
  }

  if (isLoading) return <div className="flex h-64 items-center justify-center text-foreground-muted">Loading…</div>;
  if (!credit) return <div className="flex h-64 items-center justify-center text-foreground-muted">Vendor credit not found.</div>;

  const remaining = credit.totalMinor - credit.amountAppliedMinor;

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Link href="/vendor-credits" className="rounded-md p-1.5 text-foreground-muted hover:bg-surface-muted">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold">{credit.creditNumber}</h1>
            <Badge tone={STATUS_TONE[credit.status] ?? "neutral"} className="capitalize">{credit.status}</Badge>
          </div>
          <p className="text-sm text-foreground-muted">{credit.vendorName}</p>
        </div>
        <div className="flex items-center gap-2">
          {credit.status === "draft" && (
            <>
              <Button variant="outline" size="sm" onClick={() => handleAction(() => voidCredit.mutateAsync(), "Credit voided")} loading={voidCredit.isPending}>
                <Ban className="h-4 w-4" /> Void
              </Button>
              <Button size="sm" onClick={() => handleAction(() => issueCredit.mutateAsync(), "Credit issued")} loading={issueCredit.isPending}>
                <CheckCircle className="h-4 w-4" /> Issue
              </Button>
            </>
          )}
          {credit.status === "issued" && remaining > 0 && (
            <>
              <Button variant="outline" size="sm" onClick={() => handleAction(() => voidCredit.mutateAsync(), "Credit voided")} loading={voidCredit.isPending}>
                <Ban className="h-4 w-4" /> Void
              </Button>
              <Button size="sm" onClick={() => setApplyOpen(true)}>
                <Tag className="h-4 w-4" /> Apply to Bill
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-border bg-surface p-4 space-y-1">
          <p className="text-xs text-foreground-muted">Total Credit</p>
          <MoneyDisplay minor={credit.totalMinor} currency={credit.currency} className="font-semibold" />
        </div>
        <div className="rounded-lg border border-border bg-surface p-4 space-y-1">
          <p className="text-xs text-foreground-muted">Applied</p>
          <MoneyDisplay minor={credit.amountAppliedMinor} currency={credit.currency} className="font-medium text-foreground-muted" />
        </div>
        <div className="rounded-lg border border-border bg-surface p-4 space-y-1">
          <p className="text-xs text-foreground-muted">Remaining</p>
          <MoneyDisplay minor={remaining} currency={credit.currency} className={remaining > 0 ? "font-semibold text-primary" : "font-semibold"} />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-4">
          <div className="rounded-lg border border-border bg-surface overflow-hidden">
            <div className="px-5 py-3 border-b border-border">
              <h2 className="text-sm font-semibold">Line Items</h2>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-foreground-muted">
                  <th className="px-5 py-2.5 text-left font-medium">Description</th>
                  <th className="px-3 py-2.5 text-right font-medium">Qty</th>
                  <th className="px-3 py-2.5 text-right font-medium">Unit Price</th>
                  <th className="px-3 py-2.5 text-right font-medium">Disc</th>
                  <th className="px-3 py-2.5 text-right font-medium">Tax</th>
                  <th className="px-5 py-2.5 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {credit.lineItems.map((line, i) => (
                  <tr key={i}>
                    <td className="px-5 py-3">{line.description}</td>
                    <td className="px-3 py-3 text-right text-foreground-muted">{line.quantity}</td>
                    <td className="px-3 py-3 text-right text-foreground-muted">{formatMoney(line.unitPriceMinor, credit.currency)}</td>
                    <td className="px-3 py-3 text-right text-foreground-muted">{line.discountPct > 0 ? `${line.discountPct}%` : "—"}</td>
                    <td className="px-3 py-3 text-right text-foreground-muted">{line.taxPct > 0 ? `${line.taxPct}%` : "—"}</td>
                    <td className="px-5 py-3 text-right font-medium"><MoneyDisplay minor={line.lineTotalMinor} currency={credit.currency} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="border-t border-border px-5 py-4 space-y-1.5">
              <div className="flex justify-end gap-12 text-sm">
                <span className="text-foreground-muted">Subtotal</span>
                <MoneyDisplay minor={credit.subtotalMinor} currency={credit.currency} className="w-28 text-right" />
              </div>
              <div className="flex justify-end gap-12 text-sm">
                <span className="text-foreground-muted">Tax</span>
                <MoneyDisplay minor={credit.taxTotalMinor} currency={credit.currency} className="w-28 text-right" />
              </div>
              <div className="flex justify-end gap-12 text-sm font-semibold">
                <span>Total</span>
                <MoneyDisplay minor={credit.totalMinor} currency={credit.currency} className="w-28 text-right" />
              </div>
            </div>
          </div>

          {credit.notes && (
            <div className="rounded-lg border border-border bg-surface p-5">
              <h2 className="text-sm font-semibold mb-2">Notes</h2>
              <p className="text-sm text-foreground-muted whitespace-pre-wrap">{credit.notes}</p>
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-surface p-5 space-y-3">
            <h2 className="text-sm font-semibold">Details</h2>
            <div className="flex items-start gap-2">
              <Building2 className="h-4 w-4 text-foreground-muted shrink-0 mt-0.5" />
              <div>
                <p className="font-medium">{credit.vendorName}</p>
                <Link href={`/vendors/${credit.vendorId}`} className="text-xs text-primary hover:underline">View vendor →</Link>
              </div>
            </div>
            <div>
              <p className="text-xs text-foreground-muted">Reason</p>
              <p className="text-sm mt-0.5">{credit.reason}</p>
            </div>
            <div>
              <p className="text-xs text-foreground-muted">Issue Date</p>
              <p className="text-sm font-medium mt-0.5">{credit.issueDate}</p>
            </div>
            {credit.sourceBillNumber && (
              <div>
                <p className="text-xs text-foreground-muted">From Bill</p>
                <Link href={`/bills/${credit.sourceBillId}`} className="text-sm font-medium text-primary hover:underline">{credit.sourceBillNumber}</Link>
              </div>
            )}
          </div>
        </div>
      </div>

      <Dialog open={applyOpen} onOpenChange={(o) => { if (!o) { setApplyOpen(false); reset(); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Apply Credit to Bill</DialogTitle></DialogHeader>
          <form onSubmit={handleSubmit(onApplySubmit)} className="space-y-4">
            <div className="space-y-1.5">
              <Label>Bill *</Label>
              <Select value={watch("targetBillId")} onValueChange={(v) => setValue("targetBillId", v)}>
                <SelectTrigger><SelectValue placeholder="Select bill" /></SelectTrigger>
                <SelectContent>
                  {openBills.length === 0
                    ? <SelectItem value="_none" disabled>No open bills for this vendor</SelectItem>
                    : openBills.map((b) => (
                        <SelectItem key={b.id} value={b.id}>
                          {b.billNumber} — balance {formatMoney(b.balanceMinor, b.currency)}
                        </SelectItem>
                      ))
                  }
                </SelectContent>
              </Select>
              {errors.targetBillId && <p className="text-xs text-danger">{errors.targetBillId.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label>Amount to Apply ({credit.currency}) *</Label>
              <Input type="number" step="0.01" placeholder="0.00" {...register("amountDisplay")} />
              <p className="text-xs text-foreground-muted">Available: {formatMoney(remaining, credit.currency)}</p>
              {errors.amountDisplay && <p className="text-xs text-danger">{errors.amountDisplay.message}</p>}
            </div>
            <DialogFooter>
              <DialogClose asChild><Button type="button" variant="ghost">Cancel</Button></DialogClose>
              <Button type="submit" loading={isSubmitting} disabled={openBills.length === 0}>Apply credit</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
