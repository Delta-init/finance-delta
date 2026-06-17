"use client";

import { useRouter } from "next/navigation";
import { Plus, Warehouse, ArrowLeft, MapPin } from "lucide-react";
import { type Warehouse as WarehouseType } from "@delta/shared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { useTableQuery } from "@/lib/use-table-query";
import { useWarehouses } from "@/features/inventory/api";
import Link from "next/link";

export default function WarehousesPage() {
  const router = useRouter();
  const t = useTableQuery({ initialSort: { key: "name", dir: "asc" } });
  const { data, isLoading } = useWarehouses({ ...t.baseParams });

  const columns: Column<WarehouseType>[] = [
    {
      key: "name",
      header: "Name",
      sortable: true,
      cell: (w) => (
        <div className="flex items-center gap-2">
          <span className="font-medium text-foreground">{w.name}</span>
          {w.isDefault && <Badge tone="primary">Default</Badge>}
        </div>
      ),
    },
    {
      key: "location",
      header: "Location",
      cell: (w) => w.location ? (
        <div className="flex items-center gap-1 text-foreground-muted">
          <MapPin className="h-3.5 w-3.5 shrink-0" />
          <span className="text-sm">{w.location}</span>
        </div>
      ) : <span className="text-foreground-subtle text-sm">—</span>,
    },
    {
      key: "status",
      header: "Status",
      cell: (w) => <Badge tone={w.isActive ? "success" : "neutral"}>{w.isActive ? "Active" : "Inactive"}</Badge>,
    },
  ];

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center gap-3">
        <Link href="/inventory" className="inline-flex h-8 w-8 items-center justify-center rounded-md text-foreground-muted hover:bg-surface-muted hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="flex-1">
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Warehouse className="h-5 w-5 text-foreground-muted" /> Warehouses
          </h1>
          <p className="text-sm text-foreground-muted">Manage storage locations for inventory.</p>
        </div>
        <Button onClick={() => router.push("/inventory/warehouses/new")}>
          <Plus className="h-4 w-4" /> Add warehouse
        </Button>
      </div>

      <DataTable
        columns={columns}
        data={data?.data}
        getRowId={(w) => w.id}
        total={data?.meta.total ?? 0}
        page={t.page}
        pageSize={t.pageSize}
        sort={t.sort}
        onPageChange={t.setPage}
        onPageSizeChange={t.setPageSize}
        onSortChange={t.handleSort}
        onRowClick={(w) => router.push(`/inventory/warehouses/${w.id}`)}
        isLoading={isLoading}
        emptyMessage="No warehouses. Add your first storage location."
      />
    </div>
  );
}
