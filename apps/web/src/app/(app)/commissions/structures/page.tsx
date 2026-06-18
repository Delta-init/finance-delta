"use client";

import Link from "next/link";
import { Plus, Lock, Unlock, Settings2 } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MoneyDisplay } from "@/components/ui/money";
import { DataTable, type Column } from "@/components/ui/data-table";
import { useCommissionStructures } from "@/features/commissions/api";
import type { CommissionStructure } from "@delta/shared";

const TYPE_LABELS: Record<string, string> = {
  flat: "Flat",
  percentage: "Percentage",
  tiered: "Tiered",
};

const BASIS_LABELS: Record<string, string> = {
  invoice_raised: "On Invoice",
  payment_received: "On Payment",
};

export default function StructuresPage() {
  const { data, isLoading } = useCommissionStructures();

  const columns: Column<CommissionStructure>[] = [
    {
      key: "salespersonName",
      header: "Salesperson",
      sortable: true,
      cell: (r) => (
        <Link href={`/commissions/structures/${r.id}`} className="font-medium text-foreground hover:text-primary">
          {r.salespersonName}
        </Link>
      ),
    },
    {
      key: "type",
      header: "Type",
      cell: (r) => <Badge tone="neutral">{TYPE_LABELS[r.type]}</Badge>,
    },
    {
      key: "basis",
      header: "Trigger",
      cell: (r) => <span className="text-sm text-foreground-muted">{BASIS_LABELS[r.basis]}</span>,
    },
    {
      key: "flatAmountMinor",
      header: "Rate",
      cell: (r) =>
        r.type === "flat" ? (
          <MoneyDisplay minor={r.flatAmountMinor ?? 0} />
        ) : r.type === "percentage" ? (
          <span>{r.percentage}%</span>
        ) : (
          <span className="text-foreground-muted">{(r.tiers ?? []).length} tiers</span>
        ),
    },
    {
      key: "effectiveFrom",
      header: "Effective",
      cell: (r) => (
        <span className="text-sm text-foreground-muted">
          {r.effectiveFrom}{r.effectiveTo ? ` → ${r.effectiveTo}` : ""}
        </span>
      ),
    },
    {
      key: "isLocked",
      header: "Status",
      cell: (r) => (
        <div className="flex items-center gap-2">
          {r.isLocked ? (
            <Badge tone="warning"><Lock className="mr-1 h-3 w-3" />Locked</Badge>
          ) : null}
          <Badge tone={r.isActive ? "success" : "neutral"}>
            {r.isActive ? "Active" : "Inactive"}
          </Badge>
        </div>
      ),
    },
    {
      key: "id",
      header: "",
      align: "right",
      cell: (r) => (
        <Link href={`/commissions/structures/${r.id}`}>
          <Button variant="ghost" size="sm">Edit</Button>
        </Link>
      ),
    },
  ];

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        icon={Settings2}
        title="Commission Structures"
        description="Define flat, percentage, or tiered commission rates per salesperson."
        action={
          <Link href="/commissions/structures/new">
            <Button><Plus className="h-4 w-4" /> New Structure</Button>
          </Link>
        }
      />

      <DataTable
        columns={columns}
        data={data ?? []}
        getRowId={(r) => r.id}
        total={data?.length ?? 0}
        page={1}
        pageSize={data?.length || 20}
        onPageChange={() => {}}
        onPageSizeChange={() => {}}
        isLoading={isLoading}
        emptyMessage="No commission structures yet. Create one to start tracking commissions."
      />
    </div>
  );
}
