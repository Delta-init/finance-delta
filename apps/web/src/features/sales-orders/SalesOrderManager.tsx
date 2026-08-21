"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, ClipboardList } from "lucide-react";
import type { SalesOrder } from "@delta/shared";
import { PageHeader } from "@/components/page-header";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { DataTable, type Column } from "@/components/ui/data-table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MoneyDisplay } from "@/components/ui/money";
import { ExportButton } from "@/components/ui/export-button";
import { TagList } from "@/features/tags/TagBadge";
import { TagPicker } from "@/features/tags/TagPicker";
import { useTableQuery } from "@/lib/use-table-query";
import type { ExportColumn } from "@/lib/export";
import { useSalesOrders } from "./api";

const TONE: Record<SalesOrder["status"], NonNullable<BadgeProps["tone"]>> = {
  open: "primary",
  fulfilled: "success",
  cancelled: "danger",
};

const SALES_ORDER_EXPORT_COLUMNS: ExportColumn<SalesOrder>[] = [
  { header: "Order #", value: (o) => o.orderNumber },
  { header: "Customer", value: (o) => o.customerName },
  { header: "From quote", value: (o) => o.sourceQuoteNumber ?? "" },
  { header: "Tags", value: (o) => o.tags.map((tag) => tag.name).join(", ") },
  { header: "Status", value: (o) => o.status.charAt(0).toUpperCase() + o.status.slice(1) },
  { header: "Currency", value: (o) => o.currency },
  { header: "Total", value: (o) => o.totalMinor / 100 },
  { header: "Created", value: (o) => o.createdAt.slice(0, 10) },
];

export function SalesOrderManager() {
  const router = useRouter();
  const t = useTableQuery({ initialSort: { key: "createdAt", dir: "desc" } });
  const [status, setStatus] = useState("all");
  const [tagIds, setTagIds] = useState<string[]>([]);
  useEffect(() => t.resetPage(), [status, tagIds]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data, isLoading } = useSalesOrders({
    ...t.baseParams,
    status: status === "all" ? undefined : status,
    tagIds: tagIds.length ? tagIds : undefined,
  });

  const columns: Column<SalesOrder>[] = [
    { key: "number", header: "Order #", sortable: true, cell: (o) => <span className="font-medium text-primary">{o.orderNumber}</span> },
    { key: "customer", header: "Customer", sortable: true, cell: (o) => o.customerName },
    { key: "source", header: "From quote", sortable: true, cell: (o) => <span className="font-mono text-xs text-foreground-muted">{o.sourceQuoteNumber ?? "—"}</span> },
    { key: "tags", header: "Tags", cell: (o) => <TagList tags={o.tags} /> },
    { key: "status", header: "Status", sortable: true, cell: (o) => <Badge tone={TONE[o.status]} className="capitalize">{o.status}</Badge> },
    { key: "total", header: "Total", align: "right", sortable: true, cell: (o) => <MoneyDisplay minor={o.totalMinor} currency={o.currency} className="font-medium" /> },
  ];

  return (
    <div className="space-y-4 p-6">
      <PageHeader
        icon={ClipboardList}
        title="Sales Orders"
        description="Confirmed orders converted from accepted quotations."
      />

      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-3">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle" />
          <Input value={t.q} onChange={(e) => t.setQ(e.target.value)} placeholder="Search sales orders…" className="pl-8" />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="fulfilled">Fulfilled</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
          </SelectContent>
        </Select>
        <div className="w-[220px]">
          <TagPicker value={tagIds} onChange={setTagIds} placeholder="Filter by tags…" />
        </div>
        <ExportButton
          resource="sales-orders"
          params={{
            ...t.baseParams,
            status: status === "all" ? undefined : status,
            tagIds: tagIds.length ? tagIds : undefined,
          }}
          columns={SALES_ORDER_EXPORT_COLUMNS}
          filename="sales-orders"
          title="Sales Orders"
          size="md"
        />
      </div>

      <DataTable
        columns={columns}
        data={data?.data}
        getRowId={(o) => o.id}
        total={data?.meta.total ?? 0}
        page={t.page}
        pageSize={t.pageSize}
        sort={t.sort}
        onPageChange={t.setPage}
        onPageSizeChange={t.setPageSize}
        onSortChange={t.handleSort}
        onRowClick={(o) => router.push(`/sales-orders/${o.id}`)}
        selectable
        isLoading={isLoading}
        emptyMessage="No sales orders match your filters."
      />
    </div>
  );
}
