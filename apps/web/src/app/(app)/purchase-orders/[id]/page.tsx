"use client";

import { use } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ClipboardList, Building2, Calendar, Package } from "lucide-react";
import { formatMoney } from "@delta/shared";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MoneyDisplay } from "@/components/ui/money";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { usePurchaseOrder, useSendPO, useReceivePO, useCancelPO, useConvertPOToBill } from "@/features/purchase-orders/api";

const STATUS_TONE: Record<string, NonNullable<BadgeProps["tone"]>> = {
  draft: "neutral", sent: "primary", received: "warning", billed: "success", cancelled: "danger",
};

export default function PurchaseOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { data: po, isLoading } = usePurchaseOrder(id);
  const sendPO = useSendPO(id);
  const receivePO = useReceivePO(id);
  const cancelPO = useCancelPO(id);
  const convertToBill = useConvertPOToBill(id);

  async function handleAction(action: () => Promise<unknown>, successMsg: string, redirect?: string) {
    try {
      const result = await action();
      toast.success(successMsg);
      if (redirect) router.push(redirect);
      return result;
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Action failed");
    }
  }

  if (isLoading) {
    return <div className="flex h-64 items-center justify-center text-foreground-muted">Loading…</div>;
  }
  if (!po) {
    return <div className="flex h-64 items-center justify-center text-foreground-muted">Purchase order not found.</div>;
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Link href="/purchase-orders" className="rounded-md p-1.5 text-foreground-muted hover:bg-surface-muted">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold">{po.poNumber}</h1>
            <Badge tone={STATUS_TONE[po.status] ?? "neutral"} className="capitalize">{po.status}</Badge>
          </div>
          <p className="text-sm text-foreground-muted">{po.vendorName}</p>
        </div>
        <div className="flex items-center gap-2">
          {po.status === "draft" && (
            <>
              <Button variant="outline" size="sm" onClick={() => handleAction(() => cancelPO.mutateAsync(), "PO cancelled")} loading={cancelPO.isPending}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => handleAction(() => sendPO.mutateAsync(), "PO sent to vendor")} loading={sendPO.isPending}>
                Mark as Sent
              </Button>
            </>
          )}
          {po.status === "sent" && (
            <>
              <Button variant="outline" size="sm" onClick={() => handleAction(() => cancelPO.mutateAsync(), "PO cancelled")} loading={cancelPO.isPending}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => handleAction(() => receivePO.mutateAsync(), "PO marked as received")} loading={receivePO.isPending}>
                Mark as Received
              </Button>
            </>
          )}
          {po.status === "received" && (
            <Button size="sm" onClick={async () => {
              const result = await handleAction(() => convertToBill.mutateAsync(), "Bill created from PO") as { billId: string } | undefined;
              if (result?.billId) router.push(`/bills/${result.billId}`);
            }} loading={convertToBill.isPending}>
              Convert to Bill
            </Button>
          )}
          {po.sourceBillId && (
            <Button variant="outline" size="sm" onClick={() => router.push(`/bills/${po.sourceBillId}`)}>
              View Bill
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-border bg-surface p-4 space-y-1">
          <div className="flex items-center gap-2 text-xs text-foreground-muted"><ClipboardList className="h-3.5 w-3.5" /> PO Number</div>
          <p className="font-semibold text-primary">{po.poNumber}</p>
        </div>
        <div className="rounded-lg border border-border bg-surface p-4 space-y-1">
          <div className="flex items-center gap-2 text-xs text-foreground-muted"><Calendar className="h-3.5 w-3.5" /> Issue Date</div>
          <p className="font-medium">{po.issueDate}</p>
        </div>
        <div className="rounded-lg border border-border bg-surface p-4 space-y-1">
          <div className="flex items-center gap-2 text-xs text-foreground-muted"><Package className="h-3.5 w-3.5" /> Expected</div>
          <p className="font-medium">{po.expectedDate ?? "—"}</p>
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
                {po.lineItems.map((line, i) => (
                  <tr key={i}>
                    <td className="px-5 py-3">{line.description}</td>
                    <td className="px-3 py-3 text-right text-foreground-muted">{line.quantity}</td>
                    <td className="px-3 py-3 text-right text-foreground-muted">{formatMoney(line.unitPriceMinor, po.currency)}</td>
                    <td className="px-3 py-3 text-right text-foreground-muted">{line.discountPct > 0 ? `${line.discountPct}%` : "—"}</td>
                    <td className="px-3 py-3 text-right text-foreground-muted">{line.taxPct > 0 ? `${line.taxPct}%` : "—"}</td>
                    <td className="px-5 py-3 text-right font-medium"><MoneyDisplay minor={line.lineTotalMinor} currency={po.currency} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="border-t border-border px-5 py-4 space-y-1.5">
              <div className="flex justify-end gap-12 text-sm">
                <span className="text-foreground-muted">Subtotal</span>
                <MoneyDisplay minor={po.subtotalMinor} currency={po.currency} className="w-28 text-right" />
              </div>
              <div className="flex justify-end gap-12 text-sm">
                <span className="text-foreground-muted">Tax</span>
                <MoneyDisplay minor={po.taxTotalMinor} currency={po.currency} className="w-28 text-right" />
              </div>
              <div className="flex justify-end gap-12 text-sm font-semibold">
                <span>Total</span>
                <MoneyDisplay minor={po.totalMinor} currency={po.currency} className="w-28 text-right" />
              </div>
            </div>
          </div>

          {po.notes && (
            <div className="rounded-lg border border-border bg-surface p-5">
              <h2 className="text-sm font-semibold mb-2">Notes</h2>
              <p className="text-sm text-foreground-muted whitespace-pre-wrap">{po.notes}</p>
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-surface p-5 space-y-3">
            <h2 className="text-sm font-semibold">Vendor</h2>
            <div className="flex items-center gap-2">
              <Building2 className="h-4 w-4 text-foreground-muted shrink-0" />
              <div>
                <p className="font-medium">{po.vendorName}</p>
              </div>
            </div>
            <Link href={`/vendors/${po.vendorId}`} className="text-xs text-primary hover:underline">View vendor →</Link>
          </div>

          <div className="rounded-lg border border-border bg-surface p-5 space-y-2">
            <h2 className="text-sm font-semibold">Summary</h2>
            <div className="space-y-1.5 text-sm">
              <div className="flex justify-between">
                <span className="text-foreground-muted">Currency</span>
                <span className="font-medium">{po.currency}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-foreground-muted">Status</span>
                <Badge tone={STATUS_TONE[po.status] ?? "neutral"} className="capitalize">{po.status}</Badge>
              </div>
              <div className="flex justify-between border-t border-border pt-1.5">
                <span className="font-semibold">Total</span>
                <MoneyDisplay minor={po.totalMinor} currency={po.currency} className="font-semibold" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
