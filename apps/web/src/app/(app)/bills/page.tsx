"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Search, ShoppingCart, X, AlertTriangle } from "lucide-react";
import { type Bill } from "@delta/shared";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MoneyDisplay } from "@/components/ui/money";
import { useTableQuery } from "@/lib/use-table-query";
import { useBills } from "@/features/bills/api";

const STATUS_TONE: Record<string, NonNullable<BadgeProps["tone"]>> = {
  draft: "neutral", pending_approval: "warning", approved: "primary",
  partially_paid: "warning", paid: "success", overdue: "danger", voided: "neutral",
};

export default function BillsPage() {
  const router = useRouter();
  const t = useTableQuery({ initialSort: { key: "dueDate", dir: "asc" } });
  const [status, setStatus] = useState("all");
  const [overdue, setOverdue] = useState(false);
  useEffect(() => t.resetPage(), [status, overdue]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data, isLoading } = useBills({
    ...t.baseParams,
    status: status === "all" ? undefined : status,
    overdue: overdue ? "true" : undefined,
  });

  const hasFilters = status !== "all" || overdue || !!t.q;

  const columns: Column<Bill>[] = [
    { key: "number", header: "Bill #", sortable: true, cell: (b) => <span className="font-medium text-primary">{b.billNumber}</span> },
    { key: "vendor", header: "Vendor", sortable: true, cell: (b) => b.vendorName },
    { key: "billDate", header: "Bill Date", sortable: true, cell: (b) => <span className="text-foreground-muted">{b.billDate}</span> },
    { key: "dueDate", header: "Due Date", sortable: true, cell: (b) => <span className="text-foreground-muted">{b.dueDate}</span> },
    {
      key: "status", header: "Status", sortable: true,
      cell: (b) => <Badge tone={STATUS_TONE[b.status] ?? "neutral"} className="capitalize">{b.status.replace("_", " ")}</Badge>,
    },
    { key: "total", header: "Total", align: "right", sortable: true, cell: (b) => <MoneyDisplay minor={b.totalMinor} currency={b.currency} className="font-medium" /> },
    {
      key: "balance", header: "Balance", align: "right", sortable: true,
      cell: (b) => <MoneyDisplay minor={b.balanceMinor} currency={b.currency} className={b.balanceMinor > 0 ? "font-medium text-danger" : "font-medium"} />,
    },
  ];

  return (
    <div className="space-y-4 p-6">
      <PageHeader icon={ShoppingCart} title="Bills" description="Vendor bills and payables outstanding."
        action={<Button onClick={() => router.push("/bills/new")}><Plus className="h-4 w-4" /> New bill</Button>}
      />
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-3">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle" />
          <Input value={t.q} onChange={(e) => t.setQ(e.target.value)} placeholder="Search bills…" className="pl-8" />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {["draft", "pending_approval", "approved", "partially_paid", "paid", "voided"].map((s) => (
              <SelectItem key={s} value={s} className="capitalize">{s.replace("_", " ")}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <button
          onClick={() => setOverdue(!overdue)}
          className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${overdue ? "border-danger bg-danger/10 text-danger" : "border-border text-foreground-muted hover:bg-surface-muted"}`}
        >
          <AlertTriangle className="h-3.5 w-3.5" /> Overdue only
        </button>
        {hasFilters && <Button variant="ghost" size="sm" onClick={() => { setStatus("all"); setOverdue(false); t.setQ(""); }}><X className="h-4 w-4" /> Clear</Button>}
      </div>
      <DataTable columns={columns} data={data?.data} getRowId={(b) => b.id} total={data?.meta.total ?? 0}
        page={t.page} pageSize={t.pageSize} sort={t.sort} onPageChange={t.setPage} onPageSizeChange={t.setPageSize}
        onSortChange={t.handleSort} onRowClick={(b) => router.push(`/bills/${b.id}`)}
        isLoading={isLoading} emptyMessage="No bills found." />
    </div>
  );
}
