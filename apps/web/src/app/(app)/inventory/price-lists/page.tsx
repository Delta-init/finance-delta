"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Plus, ListChecks, Trash2 } from "lucide-react";
import { type PriceList } from "@delta/shared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { useTableQuery } from "@/lib/use-table-query";
import { toast } from "@/lib/toast";
import { ApiError } from "@/lib/api";
import { usePriceLists, useDeletePriceList } from "@/features/inventory/api";

export default function PriceListsPage() {
  const router = useRouter();
  const t = useTableQuery({ initialSort: { key: "name", dir: "asc" } });
  const { data: priceLists, isLoading } = usePriceLists();
  const deletePriceList = useDeletePriceList();

  async function handleDelete(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    if (!confirm("Delete this price list?")) return;
    try {
      await deletePriceList.mutateAsync(id);
      toast.success("Price list deleted");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to delete");
    }
  }

  const columns: Column<PriceList>[] = [
    {
      key: "name",
      header: "Name",
      sortable: true,
      cell: (pl) => (
        <div className="flex items-center gap-2">
          <span className="font-medium text-foreground">{pl.name}</span>
          {pl.isDefault && <Badge tone="primary">Default</Badge>}
        </div>
      ),
    },
    {
      key: "description",
      header: "Description",
      cell: (pl) => (
        <span className="text-sm text-foreground-muted truncate max-w-xs">
          {pl.description || "—"}
        </span>
      ),
    },
    {
      key: "currency",
      header: "Currency",
      cell: (pl) => <span className="text-sm font-medium">{pl.currency}</span>,
    },
    {
      key: "entries",
      header: "Items",
      align: "right",
      cell: (pl) => (
        <span className="text-sm text-foreground-muted">{pl.entries.length}</span>
      ),
    },
    {
      key: "validFrom",
      header: "Valid",
      cell: (pl) => (
        <span className="text-sm text-foreground-muted">
          {pl.validFrom ? pl.validFrom.slice(0, 10) : "—"}
          {pl.validFrom && pl.validTo ? " → " : ""}
          {pl.validTo ? pl.validTo.slice(0, 10) : ""}
        </span>
      ),
    },
    {
      key: "actions" as keyof PriceList,
      header: "",
      cell: (pl) => (
        <Button
          variant="ghost"
          size="sm"
          onClick={(e) => handleDelete(e, pl.id)}
          className="text-danger hover:text-danger"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center gap-3">
        <Link
          href="/inventory"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-foreground-muted hover:bg-surface-muted hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="flex-1">
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <ListChecks className="h-5 w-5 text-foreground-muted" /> Price Lists
          </h1>
          <p className="text-sm text-foreground-muted">Custom pricing for customers or groups.</p>
        </div>
        <Button onClick={() => router.push("/inventory/price-lists/new")}>
          <Plus className="h-4 w-4" /> New Price List
        </Button>
      </div>

      <DataTable
        columns={columns}
        data={priceLists}
        getRowId={(pl) => pl.id}
        total={priceLists?.length ?? 0}
        page={t.page}
        pageSize={t.pageSize}
        sort={t.sort}
        onPageChange={t.setPage}
        onPageSizeChange={t.setPageSize}
        onSortChange={t.handleSort}
        onRowClick={(pl) => router.push(`/inventory/price-lists/${pl.id}`)}
        isLoading={isLoading}
        emptyMessage="No price lists. Create one to set custom pricing."
      />
    </div>
  );
}
