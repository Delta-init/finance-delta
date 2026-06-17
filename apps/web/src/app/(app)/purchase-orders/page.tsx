"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Search, ClipboardList, X } from "lucide-react";
import { type PurchaseOrder } from "@delta/shared";
import { formatMoney } from "@delta/shared";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MoneyDisplay } from "@/components/ui/money";
import { useTableQuery } from "@/lib/use-table-query";
import { usePurchaseOrders } from "@/features/purchase-orders/api";

const STATUS_TONE: Record<string, NonNullable<BadgeProps["tone"]>> = {
  draft: "neutral", sent: "primary", received: "warning", billed: "success", cancelled: "danger",
};

export default function PurchaseOrdersPage() {
  const router = useRouter();
  const t = useTableQuery({ initialSort: { key: "createdAt", dir: "desc" } });
  const [status, setStatus] = useState("all");
  useEffect(() => t.resetPage(), [status]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data, isLoading } = usePurchaseOrders({ ...t.baseParams, status: status === "all" ? undefined : status });

  const columns: Column<PurchaseOrder>[] = [
    { key: "number", header: "PO #", sortable: true, cell: (p) => <span className="font-medium text-primary">{p.poNumber}</span> },
    { key: "vendor", header: "Vendor", sortable: true, cell: (p) => p.vendorName },
    { key: "issue", header: "Issue Date", sortable: true, cell: (p) => <span className="text-foreground-muted">{p.issueDate}</span> },
    { key: "expected", header: "Expected", cell: (p) => <span className="text-foreground-muted">{p.expectedDate ?? "—"}</span> },
    { key: "status", header: "Status", sortable: true, cell: (p) => <Badge tone={STATUS_TONE[p.status]} className="capitalize">{p.status}</Badge> },
    { key: "total", header: "Total", align: "right", sortable: true, cell: (p) => <MoneyDisplay minor={p.totalMinor} currency={p.currency} className="font-medium" /> },
  ];

  return (
    <div className="space-y-4 p-6">
      <PageHeader icon={ClipboardList} title="Purchase Orders" description="Orders sent to vendors for goods and services."
        action={<Button onClick={() => router.push("/purchase-orders/new")}><Plus className="h-4 w-4" /> New PO</Button>}
      />
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-3">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle" />
          <Input value={t.q} onChange={(e) => t.setQ(e.target.value)} placeholder="Search POs…" className="pl-8" />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {["draft", "sent", "received", "billed", "cancelled"].map((s) => (
              <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {(status !== "all" || t.q) && <Button variant="ghost" size="sm" onClick={() => { setStatus("all"); t.setQ(""); }}><X className="h-4 w-4" /> Clear</Button>}
      </div>
      <DataTable columns={columns} data={data?.data} getRowId={(p) => p.id} total={data?.meta.total ?? 0}
        page={t.page} pageSize={t.pageSize} sort={t.sort} onPageChange={t.setPage} onPageSizeChange={t.setPageSize}
        onSortChange={t.handleSort} onRowClick={(p) => router.push(`/purchase-orders/${p.id}`)}
        isLoading={isLoading} emptyMessage="No purchase orders found." />
    </div>
  );
}
