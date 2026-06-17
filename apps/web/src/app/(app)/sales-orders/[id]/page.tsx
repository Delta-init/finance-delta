"use client";

import { use } from "react";
import Link from "next/link";
import { formatMoney } from "@delta/shared";
import { useSalesOrder, useCancelSalesOrder } from "@/features/sales-orders/api";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowLeft, XCircle } from "lucide-react";
import { toast } from "@/lib/toast";
import { MoneyDisplay } from "@/components/ui/money";

const STATUS_TONE: Record<string, BadgeProps["tone"]> = {
  open: "primary",
  fulfilled: "success",
  cancelled: "danger",
};

export default function SalesOrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { data: order, isLoading } = useSalesOrder(id);
  const cancel = useCancelSalesOrder();

  if (isLoading) {
    return <div className="flex h-48 items-center justify-center text-sm text-foreground-muted p-6">Loading…</div>;
  }
  if (!order) {
    return <div className="flex h-48 items-center justify-center text-sm text-foreground-muted p-6">Sales order not found.</div>;
  }

  async function handleCancel() {
    if (!confirm("Cancel this sales order? This cannot be undone.")) return;
    try {
      await cancel.mutateAsync(id);
      toast.success("Sales order cancelled");
    } catch {
      toast.error("Failed to cancel sales order");
    }
  }

  return (
    <div className="space-y-6 p-6">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-foreground-muted">
        <Link href="/sales-orders" className="flex items-center gap-1 hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Sales Orders
        </Link>
        <span>/</span>
        <span className="font-medium text-foreground">{order.orderNumber}</span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold">{order.orderNumber}</h1>
            <Badge tone={STATUS_TONE[order.status] ?? "neutral"} className="capitalize">
              {order.status}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-foreground-muted">
            Customer: <span className="font-medium text-foreground">{order.customerName}</span>
            {order.sourceQuoteNumber && (
              <>
                {" · "}From quote:{" "}
                {order.sourceQuoteId ? (
                  <Link href={`/quotations/${order.sourceQuoteId}`} className="text-primary hover:underline">
                    {order.sourceQuoteNumber}
                  </Link>
                ) : (
                  <span>{order.sourceQuoteNumber}</span>
                )}
              </>
            )}
          </p>
        </div>
        {order.status === "open" && (
          <Button size="sm" variant="destructive" onClick={handleCancel} loading={cancel.isPending}>
            <XCircle className="h-4 w-4" /> Cancel Order
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Line items */}
        <div className="lg:col-span-2">
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-foreground-muted">
                  <th className="px-4 py-3 font-medium">Description</th>
                  <th className="px-4 py-3 text-right font-medium">Qty</th>
                  <th className="px-4 py-3 text-right font-medium">Unit Price</th>
                  <th className="px-4 py-3 text-right font-medium">Disc %</th>
                  <th className="px-4 py-3 text-right font-medium">Tax %</th>
                  <th className="px-4 py-3 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {order.lineItems.map((line, i) => (
                  <tr key={i} className="border-t border-border">
                    <td className="px-4 py-3">{line.description}</td>
                    <td className="px-4 py-3 text-right">{line.quantity}</td>
                    <td className="px-4 py-3 text-right font-numeric">
                      {formatMoney(line.unitPriceMinor, order.currency)}
                    </td>
                    <td className="px-4 py-3 text-right">{line.discountPct > 0 ? `${line.discountPct}%` : "—"}</td>
                    <td className="px-4 py-3 text-right">{line.taxPct > 0 ? `${line.taxPct}%` : "—"}</td>
                    <td className="px-4 py-3 text-right font-numeric font-medium">
                      {formatMoney(line.lineTotalMinor, order.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Summary panel */}
        <div className="space-y-4">
          <div className="rounded-xl border border-border bg-card p-5 space-y-3">
            <h2 className="text-sm font-semibold text-foreground-muted uppercase tracking-wide">Summary</h2>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-foreground-muted">Subtotal</span>
                <MoneyDisplay minor={order.subtotalMinor} currency={order.currency} className="font-numeric" />
              </div>
              {order.discountTotalMinor > 0 && (
                <div className="flex justify-between">
                  <span className="text-foreground-muted">Discount</span>
                  <MoneyDisplay minor={order.discountTotalMinor} currency={order.currency} className="font-numeric text-warning" />
                </div>
              )}
              {order.taxTotalMinor > 0 && (
                <div className="flex justify-between">
                  <span className="text-foreground-muted">Tax</span>
                  <MoneyDisplay minor={order.taxTotalMinor} currency={order.currency} className="font-numeric" />
                </div>
              )}
              <div className="flex justify-between border-t border-border pt-2 font-semibold">
                <span>Total</span>
                <MoneyDisplay minor={order.totalMinor} currency={order.currency} className="font-numeric text-base" />
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card p-5 space-y-2 text-sm">
            <h2 className="text-sm font-semibold text-foreground-muted uppercase tracking-wide">Details</h2>
            <div className="flex justify-between">
              <span className="text-foreground-muted">Created</span>
              <span>{order.createdAt.slice(0, 10)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-foreground-muted">Currency</span>
              <span>{order.currency}</span>
            </div>
            {order.tags.length > 0 && (
              <div className="flex flex-wrap gap-1 pt-1">
                {order.tags.map((t) => (
                  <span key={t.id} className="rounded-full px-2 py-0.5 text-xs font-medium" style={{ background: t.color + "33", color: t.color }}>
                    {t.name}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
