"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft, Package, AlertTriangle, Warehouse, TrendingUp, TrendingDown,
  Edit, Trash2, ToggleLeft, ToggleRight,
} from "lucide-react";
import {
  type StockLevel, type StockMovement, type ItemUnit,
  ITEM_UNIT_LABELS, MOVEMENT_TYPE_LABELS, type MovementType,
} from "@delta/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, type Column } from "@/components/ui/data-table";
import { MoneyDisplay } from "@/components/ui/money";
import { useTableQuery } from "@/lib/use-table-query";
import { toast } from "@/lib/toast";
import { ApiError } from "@/lib/api";
import {
  useItem, useStockLevels, useStockMovements, useUpdateItem, useDeleteItem,
} from "@/features/inventory/api";
import { useAllDepartments } from "@/features/departments/api";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useCurrency } from "@/lib/currency-context";

const MOVEMENT_TONE: Record<MovementType, "success" | "danger" | "neutral"> = {
  purchase_in: "success",
  invoice_out: "danger",
  adjustment_in: "success",
  adjustment_out: "danger",
  transfer_in: "success",
  transfer_out: "danger",
  opening: "neutral",
};

export default function ItemDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { currency: orgCurrency } = useCurrency();
  const { data: item, isLoading } = useItem(id);
  const { data: stockLevels } = useStockLevels(id);
  const t = useTableQuery({ initialSort: { key: "movementDate", dir: "desc" } });
  const { data: movements } = useStockMovements(id, t.baseParams);
  const updateItem = useUpdateItem(id);
  const deleteItem = useDeleteItem();
  const { data: departments } = useAllDepartments();
  const [deleting, setDeleting] = useState(false);

  async function handleDepartmentChange(departmentId: string) {
    try {
      await updateItem.mutateAsync({ departmentId });
      toast.success("Department updated");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to update department");
    }
  }

  async function handleToggleActive() {
    if (!item) return;
    try {
      await updateItem.mutateAsync({ isActive: !item.isActive });
      toast.success(item.isActive ? "Item deactivated" : "Item activated");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to update item");
    }
  }

  async function handleDelete() {
    if (!confirm("Delete this item? This cannot be undone.")) return;
    setDeleting(true);
    try {
      await deleteItem.mutateAsync(id);
      toast.success("Item deleted");
      router.push("/inventory");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to delete item");
      setDeleting(false);
    }
  }

  const stockColumns: Column<StockLevel>[] = [
    {
      key: "warehouseName",
      header: "Warehouse",
      cell: (sl) => (
        <div className="flex items-center gap-2">
          <Warehouse className="h-3.5 w-3.5 text-foreground-muted shrink-0" />
          <span className="font-medium">{sl.warehouseName}</span>
        </div>
      ),
    },
    {
      key: "quantityOnHand",
      header: "On Hand",
      align: "right",
      cell: (sl) => (
        <span className="font-semibold text-foreground">
          {sl.quantityOnHand} <span className="text-xs font-normal text-foreground-muted">
            {ITEM_UNIT_LABELS[item?.unit as ItemUnit] ?? item?.unit}
          </span>
        </span>
      ),
    },
    {
      key: "avgCostMinor",
      header: "Avg Cost",
      align: "right",
      cell: (sl) => <MoneyDisplay minor={sl.avgCostMinor} currency={orgCurrency} className="text-foreground-muted" />,
    },
    {
      key: "valuationMinor",
      header: "Valuation",
      align: "right",
      cell: (sl) => <MoneyDisplay minor={sl.valuationMinor} currency={orgCurrency} className="font-medium" />,
    },
  ];

  const movementColumns: Column<StockMovement>[] = [
    {
      key: "movementDate",
      header: "Date",
      sortable: true,
      cell: (m) => <span className="text-foreground-muted text-sm">{m.movementDate.slice(0, 10)}</span>,
    },
    {
      key: "movementType",
      header: "Type",
      cell: (m) => (
        <Badge tone={MOVEMENT_TONE[m.movementType]}>
          {MOVEMENT_TYPE_LABELS[m.movementType]}
        </Badge>
      ),
    },
    {
      key: "warehouseName",
      header: "Warehouse",
      cell: (m) => <span className="text-sm text-foreground-muted">{m.warehouseName}</span>,
    },
    {
      key: "quantity",
      header: "Qty",
      align: "right",
      cell: (m) => {
        const isOut = m.movementType.endsWith("_out");
        return (
          <span className={`font-medium flex items-center justify-end gap-1 ${isOut ? "text-danger" : "text-success"}`}>
            {isOut ? <TrendingDown className="h-3.5 w-3.5" /> : <TrendingUp className="h-3.5 w-3.5" />}
            {isOut ? "-" : "+"}{m.quantity}
          </span>
        );
      },
    },
    {
      key: "beforeQty",
      header: "Before → After",
      align: "right",
      cell: (m) => (
        <span className="text-sm text-foreground-muted">
          {m.beforeQty} → {m.afterQty}
        </span>
      ),
    },
    {
      key: "reference",
      header: "Reference",
      cell: (m) => (
        <div>
          {m.reference && <p className="text-sm text-foreground">{m.reference}</p>}
          {m.notes && <p className="text-xs text-foreground-muted truncate max-w-[160px]">{m.notes}</p>}
        </div>
      ),
    },
    {
      key: "createdByName",
      header: "By",
      cell: (m) => <span className="text-xs text-foreground-muted">{m.createdByName}</span>,
    },
  ];

  if (isLoading) {
    return <div className="p-6 text-foreground-muted">Loading…</div>;
  }
  if (!item) {
    return <div className="p-6 text-foreground-muted">Item not found.</div>;
  }

  const unit = ITEM_UNIT_LABELS[item.unit as ItemUnit] ?? item.unit;

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-start gap-4">
        <Link
          href="/inventory"
          className="mt-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-foreground-muted hover:bg-surface-muted hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-xl font-semibold truncate">{item.name}</h1>
            <Badge tone={item.isActive ? "success" : "neutral"}>{item.isActive ? "Active" : "Inactive"}</Badge>
            <Badge tone={item.type === "product" ? "primary" : "neutral"}>
              {item.type === "product" ? "Product" : "Service"}
            </Badge>
            {item.isLowStock && (
              <Badge tone="warning">
                <AlertTriangle className="h-3 w-3 mr-1" /> Low Stock
              </Badge>
            )}
          </div>
          <p className="text-sm text-foreground-muted mt-0.5">{item.itemNumber} · SKU: {item.sku}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {item.type === "product" && item.trackStock && (
            <Button
              variant="outline"
              onClick={() => router.push(`/inventory/${id}/adjust`)}
            >
              Adjust Stock
            </Button>
          )}
          <Button variant="outline" onClick={handleToggleActive}>
            {item.isActive ? <ToggleRight className="h-4 w-4" /> : <ToggleLeft className="h-4 w-4" />}
            {item.isActive ? "Deactivate" : "Activate"}
          </Button>
          <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
            <Trash2 className="h-4 w-4" />
            Delete
          </Button>
        </div>
      </div>

      {/* Info cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="text-xs font-medium text-foreground-muted uppercase tracking-wide">Unit Price</p>
          <MoneyDisplay minor={item.unitPriceMinor} currency={orgCurrency} className="mt-1 text-xl font-semibold" />
        </div>
        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="text-xs font-medium text-foreground-muted uppercase tracking-wide">Cost Price</p>
          <MoneyDisplay minor={item.costPriceMinor} currency={orgCurrency} className="mt-1 text-xl font-semibold" />
        </div>
        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="text-xs font-medium text-foreground-muted uppercase tracking-wide">Total Stock</p>
          <div className="mt-1 flex items-baseline gap-1">
            <span className={`text-xl font-semibold ${item.isLowStock ? "text-warning" : "text-foreground"}`}>
              {item.totalStock}
            </span>
            <span className="text-sm text-foreground-muted">{unit}</span>
          </div>
        </div>
        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="text-xs font-medium text-foreground-muted uppercase tracking-wide">Reorder Point</p>
          <div className="mt-1 flex items-baseline gap-1">
            <span className="text-xl font-semibold">{item.reorderPoint}</span>
            <span className="text-sm text-foreground-muted">{unit}</span>
          </div>
        </div>
      </div>

      {/* Details card */}
      <div className="rounded-lg border border-border bg-surface p-6">
        <h2 className="text-sm font-semibold text-foreground-muted uppercase tracking-wide mb-4">Details</h2>
        <div className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm">
          <div>
            <span className="text-foreground-muted">Unit of Measure</span>
            <span className="ml-3 font-medium text-foreground">{unit}</span>
          </div>
          <div>
            <span className="text-foreground-muted">Track Stock</span>
            <span className="ml-3 font-medium text-foreground">{item.trackStock ? "Yes" : "No"}</span>
          </div>
          {item.trackStock && (
            <div>
              <span className="text-foreground-muted">Reorder Qty</span>
              <span className="ml-3 font-medium text-foreground">{item.reorderQty} {unit}</span>
            </div>
          )}
          {(departments?.length ?? 0) > 0 && (
            <div className="flex items-center">
              <span className="text-foreground-muted shrink-0">Department</span>
              <div className="ml-3 w-48">
                <Select
                  key={item.department?.id ?? "none"}
                  value={item.department?.id ?? ""}
                  onValueChange={handleDepartmentChange}
                >
                  <SelectTrigger className="h-8">
                    <SelectValue placeholder="None" />
                  </SelectTrigger>
                  <SelectContent>
                    {departments?.map((d) => (
                      <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
          {item.description && (
            <div className="col-span-2">
              <span className="text-foreground-muted">Description</span>
              <span className="ml-3 text-foreground">{item.description}</span>
            </div>
          )}
        </div>
        {item.photoUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.photoUrl} alt={item.name} className="mt-4 h-24 w-24 rounded-lg object-cover border border-border" />
        )}
      </div>

      {/* Stock levels per warehouse */}
      {item.type === "product" && item.trackStock && (
        <div className="rounded-lg border border-border bg-surface p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground-muted uppercase tracking-wide flex items-center gap-2">
              <Package className="h-4 w-4" /> Stock by Warehouse
            </h2>
            <Button size="sm" onClick={() => router.push(`/inventory/${id}/adjust`)}>
              Adjust Stock
            </Button>
          </div>
          {!stockLevels || stockLevels.length === 0 ? (
            <p className="text-sm text-foreground-muted">No stock records yet.</p>
          ) : (
            <DataTable
              columns={stockColumns}
              data={stockLevels}
              getRowId={(sl) => sl.id}
              total={stockLevels.length}
              page={1}
              pageSize={50}
              sort={{ key: "warehouseName", dir: "asc" }}
              onPageChange={() => {}}
              onPageSizeChange={() => {}}
              onSortChange={() => {}}
            />
          )}
        </div>
      )}

      {/* Movement history */}
      <div className="rounded-lg border border-border bg-surface p-6 space-y-4">
        <h2 className="text-sm font-semibold text-foreground-muted uppercase tracking-wide">Movement History</h2>
        <DataTable
          columns={movementColumns}
          data={movements?.data}
          getRowId={(m) => m.id}
          total={movements?.meta.total ?? 0}
          page={t.page}
          pageSize={t.pageSize}
          sort={t.sort}
          onPageChange={t.setPage}
          onPageSizeChange={t.setPageSize}
          onSortChange={t.handleSort}
          emptyMessage="No movements recorded."
        />
      </div>
    </div>
  );
}
