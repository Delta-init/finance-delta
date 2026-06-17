"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Search, ReceiptText, X } from "lucide-react";
import { type VendorCredit } from "@delta/shared";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MoneyDisplay } from "@/components/ui/money";
import { useTableQuery } from "@/lib/use-table-query";
import { useVendorCredits } from "@/features/vendor-credits/api";

const STATUS_TONE: Record<string, NonNullable<BadgeProps["tone"]>> = {
  draft: "neutral", issued: "primary", applied: "success", voided: "neutral",
};

export default function VendorCreditsPage() {
  const router = useRouter();
  const t = useTableQuery({ initialSort: { key: "createdAt", dir: "desc" } });
  const [status, setStatus] = useState("all");
  useEffect(() => t.resetPage(), [status]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data, isLoading } = useVendorCredits({
    ...t.baseParams,
    status: status === "all" ? undefined : status,
  });

  const hasFilters = status !== "all" || !!t.q;

  const columns: Column<VendorCredit>[] = [
    { key: "number", header: "Credit #", sortable: true, cell: (vc) => <span className="font-medium text-primary">{vc.creditNumber}</span> },
    { key: "vendor", header: "Vendor", sortable: true, cell: (vc) => vc.vendorName },
    { key: "issueDate", header: "Issue Date", sortable: true, cell: (vc) => <span className="text-foreground-muted">{vc.issueDate}</span> },
    { key: "reason", header: "Reason", cell: (vc) => <span className="text-foreground-muted truncate max-w-[200px] block">{vc.reason}</span> },
    {
      key: "status", header: "Status", sortable: true,
      cell: (vc) => <Badge tone={STATUS_TONE[vc.status] ?? "neutral"} className="capitalize">{vc.status}</Badge>,
    },
    { key: "total", header: "Total", align: "right", sortable: true, cell: (vc) => <MoneyDisplay minor={vc.totalMinor} currency={vc.currency} className="font-medium" /> },
    {
      key: "applied", header: "Applied", align: "right",
      cell: (vc) => <MoneyDisplay minor={vc.amountAppliedMinor} currency={vc.currency} className="font-medium text-foreground-muted" />,
    },
  ];

  return (
    <div className="space-y-4 p-6">
      <PageHeader icon={ReceiptText} title="Vendor Credits" description="Credits received from vendors, applied against bills."
        action={<Button onClick={() => router.push("/vendor-credits/new")}><Plus className="h-4 w-4" /> New credit</Button>}
      />
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-3">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle" />
          <Input value={t.q} onChange={(e) => t.setQ(e.target.value)} placeholder="Search credits…" className="pl-8" />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {["draft", "issued", "applied", "voided"].map((s) => (
              <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {hasFilters && <Button variant="ghost" size="sm" onClick={() => { setStatus("all"); t.setQ(""); }}><X className="h-4 w-4" /> Clear</Button>}
      </div>
      <DataTable columns={columns} data={data?.data} getRowId={(vc) => vc.id} total={data?.meta.total ?? 0}
        page={t.page} pageSize={t.pageSize} sort={t.sort} onPageChange={t.setPage} onPageSizeChange={t.setPageSize}
        onSortChange={t.handleSort} onRowClick={(vc) => router.push(`/vendor-credits/${vc.id}`)}
        isLoading={isLoading} emptyMessage="No vendor credits found." />
    </div>
  );
}
