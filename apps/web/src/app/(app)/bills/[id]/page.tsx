"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeft, Building2, Calendar, CheckCircle, XCircle, Ban, CreditCard } from "lucide-react";
import { formatMoney, recordBillPaymentSchema, type RecordBillPaymentInput } from "@delta/shared";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyDisplay } from "@/components/ui/money";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useBill, useApproveBill, useRejectBill, useVoidBill, useRecordBillPayment } from "@/features/bills/api";

const STATUS_TONE: Record<string, NonNullable<BadgeProps["tone"]>> = {
  draft: "neutral", pending_approval: "warning", approved: "primary",
  partially_paid: "warning", paid: "success", overdue: "danger", voided: "neutral",
};

const PAYMENT_METHODS = ["bank_transfer", "cash", "cheque", "card", "online"] as const;

function toMinorFromInput(val: string): number {
  const n = parseFloat(val);
  return isNaN(n) ? 0 : Math.round(n * 100);
}

export default function BillDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { data: bill, isLoading } = useBill(id);
  const approveBill = useApproveBill(id);
  const rejectBill = useRejectBill(id);
  const voidBill = useVoidBill(id);
  const recordPayment = useRecordBillPayment(id);
  const [paymentOpen, setPaymentOpen] = useState(false);

  const { register, handleSubmit, watch, setValue, reset, formState: { errors, isSubmitting } } =
    useForm<RecordBillPaymentInput & { amountDisplay: string }>({
      resolver: zodResolver(recordBillPaymentSchema.extend({ amountDisplay: recordBillPaymentSchema.shape.amountMinor.optional() })),
      defaultValues: { method: "bank_transfer", amountMinor: 0, paidOn: new Date().toISOString().slice(0, 10), reference: "", accountName: "", notes: "" },
    });

  async function handleAction(action: () => Promise<unknown>, msg: string) {
    try {
      await action();
      toast.success(msg);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Action failed");
    }
  }

  async function onPaymentSubmit(values: RecordBillPaymentInput) {
    try {
      await recordPayment.mutateAsync(values);
      toast.success("Payment recorded");
      setPaymentOpen(false);
      reset();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to record payment");
    }
  }

  if (isLoading) return <div className="flex h-64 items-center justify-center text-foreground-muted">Loading…</div>;
  if (!bill) return <div className="flex h-64 items-center justify-center text-foreground-muted">Bill not found.</div>;

  const canPay = bill.status === "approved" || bill.status === "partially_paid" || bill.status === "overdue";
  const canApprove = bill.approvalStatus === "pending";

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Link href="/bills" className="rounded-md p-1.5 text-foreground-muted hover:bg-surface-muted">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold">{bill.billNumber}</h1>
            <Badge tone={STATUS_TONE[bill.status] ?? "neutral"} className="capitalize">{bill.status.replace("_", " ")}</Badge>
            {canApprove && <Badge tone="warning">Pending approval</Badge>}
          </div>
          <p className="text-sm text-foreground-muted">{bill.vendorName}</p>
        </div>
        <div className="flex items-center gap-2">
          {canApprove && (
            <>
              <Button variant="outline" size="sm" onClick={() => handleAction(() => rejectBill.mutateAsync(undefined), "Bill rejected")} loading={rejectBill.isPending}>
                <XCircle className="h-4 w-4" /> Reject
              </Button>
              <Button size="sm" onClick={() => handleAction(() => approveBill.mutateAsync(undefined), "Bill approved")} loading={approveBill.isPending}>
                <CheckCircle className="h-4 w-4" /> Approve
              </Button>
            </>
          )}
          {canPay && (
            <Button size="sm" onClick={() => setPaymentOpen(true)}>
              <CreditCard className="h-4 w-4" /> Record Payment
            </Button>
          )}
          {(bill.status === "draft" || bill.status === "approved") && (
            <Button variant="outline" size="sm" onClick={() => handleAction(() => voidBill.mutateAsync(undefined), "Bill voided")} loading={voidBill.isPending}>
              <Ban className="h-4 w-4" /> Void
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-4">
        <div className="rounded-lg border border-border bg-surface p-4 space-y-1">
          <p className="text-xs text-foreground-muted">Bill Date</p>
          <p className="font-medium">{bill.billDate}</p>
        </div>
        <div className="rounded-lg border border-border bg-surface p-4 space-y-1">
          <p className="text-xs text-foreground-muted">Due Date</p>
          <p className="font-medium">{bill.dueDate}</p>
        </div>
        <div className="rounded-lg border border-border bg-surface p-4 space-y-1">
          <p className="text-xs text-foreground-muted">Amount Paid</p>
          <MoneyDisplay minor={bill.amountPaidMinor} currency={bill.currency} className="font-medium" />
        </div>
        <div className="rounded-lg border border-border bg-surface p-4 space-y-1">
          <p className="text-xs text-foreground-muted">Balance Due</p>
          <MoneyDisplay minor={bill.balanceMinor} currency={bill.currency} className={bill.balanceMinor > 0 ? "font-semibold text-danger" : "font-semibold"} />
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
                {bill.lineItems.map((line, i) => (
                  <tr key={i}>
                    <td className="px-5 py-3">{line.description}</td>
                    <td className="px-3 py-3 text-right text-foreground-muted">{line.quantity}</td>
                    <td className="px-3 py-3 text-right text-foreground-muted">{formatMoney(line.unitPriceMinor, bill.currency)}</td>
                    <td className="px-3 py-3 text-right text-foreground-muted">{line.discountPct > 0 ? `${line.discountPct}%` : "—"}</td>
                    <td className="px-3 py-3 text-right text-foreground-muted">{line.taxPct > 0 ? `${line.taxPct}%` : "—"}</td>
                    <td className="px-5 py-3 text-right font-medium"><MoneyDisplay minor={line.lineTotalMinor} currency={bill.currency} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="border-t border-border px-5 py-4 space-y-1.5">
              <div className="flex justify-end gap-12 text-sm">
                <span className="text-foreground-muted">Subtotal</span>
                <MoneyDisplay minor={bill.subtotalMinor} currency={bill.currency} className="w-28 text-right" />
              </div>
              <div className="flex justify-end gap-12 text-sm">
                <span className="text-foreground-muted">Tax</span>
                <MoneyDisplay minor={bill.taxTotalMinor} currency={bill.currency} className="w-28 text-right" />
              </div>
              <div className="flex justify-end gap-12 text-sm font-semibold">
                <span>Total</span>
                <MoneyDisplay minor={bill.totalMinor} currency={bill.currency} className="w-28 text-right" />
              </div>
            </div>
          </div>

          {bill.payments.length > 0 && (
            <div className="rounded-lg border border-border bg-surface overflow-hidden">
              <div className="px-5 py-3 border-b border-border">
                <h2 className="text-sm font-semibold">Payments</h2>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-xs text-foreground-muted">
                    <th className="px-5 py-2.5 text-left font-medium">Date</th>
                    <th className="px-3 py-2.5 text-left font-medium">Method</th>
                    <th className="px-3 py-2.5 text-left font-medium">Account</th>
                    <th className="px-3 py-2.5 text-left font-medium">Reference</th>
                    <th className="px-5 py-2.5 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {bill.payments.map((p) => (
                    <tr key={p.id}>
                      <td className="px-5 py-3 text-foreground-muted">{p.paidOn}</td>
                      <td className="px-3 py-3 capitalize">{p.method.replace("_", " ")}</td>
                      <td className="px-3 py-3 text-foreground-muted">{p.accountName || "—"}</td>
                      <td className="px-3 py-3 text-foreground-muted">{p.reference || "—"}</td>
                      <td className="px-5 py-3 text-right font-medium"><MoneyDisplay minor={p.amountMinor} currency={bill.currency} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {bill.notes && (
            <div className="rounded-lg border border-border bg-surface p-5">
              <h2 className="text-sm font-semibold mb-2">Notes</h2>
              <p className="text-sm text-foreground-muted whitespace-pre-wrap">{bill.notes}</p>
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-surface p-5 space-y-3">
            <h2 className="text-sm font-semibold">Vendor</h2>
            <div className="flex items-start gap-2">
              <Building2 className="h-4 w-4 text-foreground-muted shrink-0 mt-0.5" />
              <p className="font-medium">{bill.vendorName}</p>
            </div>
            <Link href={`/vendors/${bill.vendorId}`} className="text-xs text-primary hover:underline">View vendor →</Link>
            {bill.sourcePONumber && (
              <div className="pt-1 border-t border-border">
                <p className="text-xs text-foreground-muted">From PO</p>
                <Link href={`/purchase-orders/${bill.sourcePOId}`} className="text-sm font-medium text-primary hover:underline">{bill.sourcePONumber}</Link>
              </div>
            )}
          </div>

          <div className="rounded-lg border border-border bg-surface p-5 space-y-2">
            <h2 className="text-sm font-semibold">Summary</h2>
            <div className="space-y-1.5 text-sm">
              <div className="flex justify-between">
                <span className="text-foreground-muted">Total</span>
                <MoneyDisplay minor={bill.totalMinor} currency={bill.currency} className="font-medium" />
              </div>
              <div className="flex justify-between">
                <span className="text-foreground-muted">Paid</span>
                <MoneyDisplay minor={bill.amountPaidMinor} currency={bill.currency} className="font-medium text-success" />
              </div>
              <div className="flex justify-between border-t border-border pt-1.5">
                <span className="font-semibold">Balance</span>
                <MoneyDisplay minor={bill.balanceMinor} currency={bill.currency} className={bill.balanceMinor > 0 ? "font-semibold text-danger" : "font-semibold"} />
              </div>
            </div>
          </div>

          {bill.paymentTerms && (
            <div className="rounded-lg border border-border bg-surface p-4 space-y-1">
              <p className="text-xs text-foreground-muted">Payment Terms</p>
              <p className="text-sm font-medium">{bill.paymentTerms}</p>
            </div>
          )}
        </div>
      </div>

      <Dialog open={paymentOpen} onOpenChange={(o) => { if (!o) { setPaymentOpen(false); reset(); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Record Payment</DialogTitle></DialogHeader>
          <form onSubmit={handleSubmit(onPaymentSubmit)} className="space-y-4">
            <div className="space-y-1.5">
              <Label>Payment Method *</Label>
              <Select value={watch("method")} onValueChange={(v) => setValue("method", v as RecordBillPaymentInput["method"])}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PAYMENT_METHODS.map((m) => (
                    <SelectItem key={m} value={m} className="capitalize">{m.replace("_", " ")}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Amount ({bill.currency}) *</Label>
                <Input
                  type="number"
                  step="0.01"
                  placeholder="0.00"
                  onChange={(e) => setValue("amountMinor", toMinorFromInput(e.target.value))}
                />
                {errors.amountMinor && <p className="text-xs text-danger">{errors.amountMinor.message}</p>}
              </div>
              <div className="space-y-1.5">
                <Label>Payment Date *</Label>
                <Input type="date" {...register("paidOn")} />
                {errors.paidOn && <p className="text-xs text-danger">{errors.paidOn.message}</p>}
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Account / Bank</Label>
                <Input {...register("accountName")} placeholder="Account name" />
              </div>
              <div className="space-y-1.5">
                <Label>Reference</Label>
                <Input {...register("reference")} placeholder="Ref / check #" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Notes</Label>
              <Input {...register("notes")} placeholder="Optional notes" />
            </div>
            <DialogFooter>
              <DialogClose asChild><Button type="button" variant="ghost">Cancel</Button></DialogClose>
              <Button type="submit" loading={isSubmitting}>Record payment</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
