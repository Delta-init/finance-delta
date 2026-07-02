"use client";

import { useRouter } from "next/navigation";
import { useState, useEffect } from "react";
import { Plus, Package, Search, X, AlertTriangle, Warehouse, ListChecks, BarChart3 } from "lucide-react";
import { type Item, ITEM_UNIT_LABELS, type ItemUnit } from "@delta/shared";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MoneyDisplay } from "@/components/ui/money";
import { useTableQuery } from "@/lib/use-table-query";
import { useItems, useLowStockItems } from "@/features/inventory/api";
import { useCurrency } from "@/lib/currency-context";

export default function InventoryPage() {
  const router = useRouter();
  const { currency: orgCurrency } = useCurrency();
  const t = useTableQuery({ initialSort: { key: "name", dir: "asc" } });
  const [type, setType] = useState("all");
  const [lowStock, setLowStock] = useState(false);
  const [isActive, setIsActive] = useState("all");
  useEffect(() => t.resetPage(), [type, lowStock, isActive]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data, isLoading } = useItems({
    ...t.baseParams,
    type: type === "all" ? undefined : type,
    lowStock: lowStock ? "true" : undefined,
    isActive: isActive === "all" ? undefined : isActive,
  });
  const { data: lowStockItems } = useLowStockItems();
  const lowStockCount = lowStockItems?.length ?? 0;

  const hasFilters = type !== "all" || lowStock || isActive !== "all" || !!t.q;

  const columns: Column<Item>[] = [
    {
      key: "name",
      header: "Item",
      sortable: true,
      cell: (item) => (
        <div className="flex items-center gap-3">
          {item.photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={item.photoUrl} alt={item.name} className="h-8 w-8 rounded object-cover shrink-0" />
          ) : (
            <div className="h-8 w-8 rounded bg-surface-muted flex items-center justify-center shrink-0">
              <Package className="h-4 w-4 text-foreground-subtle" />
            </div>
          )}
          <div>
            <p className="font-medium text-primary">{item.name}</p>
            <p className="text-xs text-foreground-muted">{item.itemNumber} · {item.sku}</p>
          </div>
        </div>
      ),
    },
    {
      key: "type",
      header: "Type",
      sortable: true,
      cell: (item) => (
        <Badge tone={item.type === "product" ? "primary" : "neutral"}>
          {item.type === "product" ? "Product" : "Service"}
        </Badge>
      ),
    },
    {
      key: "unit",
      header: "Unit",
      cell: (item) => (
        <span className="text-foreground-muted text-sm">
          {ITEM_UNIT_LABELS[item.unit as ItemUnit] ?? item.unit}
        </span>
      ),
    },
    {
      key: "stock",
      header: "In Stock",
      align: "right",
      cell: (item) => {
        if (!item.trackStock || item.type === "service") {
          return <span className="text-foreground-subtle text-sm">—</span>;
        }
        return (
          <div className="flex items-center justify-end gap-1.5">
            {item.isLowStock && <AlertTriangle className="h-3.5 w-3.5 text-warning" />}
            <span className={`font-medium ${item.isLowStock ? "text-warning" : "text-foreground"}`}>
              {item.totalStock}
            </span>
            <span className="text-xs text-foreground-subtle">
              {ITEM_UNIT_LABELS[item.unit as ItemUnit] ?? item.unit}
            </span>
          </div>
        );
      },
    },
    {
      key: "price",
      header: "Unit Price",
      align: "right",
      sortable: true,
      cell: (item) => <MoneyDisplay minor={item.unitPriceMinor} currency={orgCurrency} className="font-medium" />,
    },
    {
      key: "cost",
      header: "Cost",
      align: "right",
      sortable: true,
      cell: (item) => <MoneyDisplay minor={item.costPriceMinor} currency={orgCurrency} className="text-foreground-muted" />,
    },
    {
      key: "status",
      header: "Status",
      cell: (item) => (
        <Badge tone={item.isActive ? "success" : "neutral"}>
          {item.isActive ? "Active" : "Inactive"}
        </Badge>
      ),
    },
  ];

  return (
    <div className="space-y-4 p-6">
      <PageHeader
        icon={Package}
        title="Inventory"
        description="Manage items, stock levels, and pricing."
        action={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => router.push("/inventory/warehouses")}>
              <Warehouse className="h-4 w-4" /> Warehouses
            </Button>
            <Button variant="outline" onClick={() => router.push("/inventory/price-lists")}>
              <ListChecks className="h-4 w-4" /> Price Lists
            </Button>
            <Button variant="outline" onClick={() => router.push("/inventory/valuation")}>
              <BarChart3 className="h-4 w-4" /> Valuation
            </Button>
            <Button onClick={() => router.push("/inventory/new")}>
              <Plus className="h-4 w-4" /> New item
            </Button>
          </div>
        }
      />

      {lowStockCount > 0 && !lowStock && (
        <button
          onClick={() => setLowStock(true)}
          className="flex w-full items-center gap-3 rounded-lg border border-warning/30 bg-warning/5 p-3 text-left hover:bg-warning/10 transition-colors"
        >
          <AlertTriangle className="h-4 w-4 text-warning shrink-0" />
          <span className="text-sm font-medium text-warning">
            {lowStockCount} item{lowStockCount !== 1 ? "s" : ""} below reorder point
          </span>
          <span className="ml-auto text-xs text-warning/70">View →</span>
        </button>
      )}

      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-3">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle" />
          <Input
            value={t.q}
            onChange={(e) => t.setQ(e.target.value)}
            placeholder="Search items…"
            className="pl-8"
          />
        </div>

        <Select value={type} onValueChange={setType}>
          <SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            <SelectItem value="product">Product</SelectItem>
            <SelectItem value="service">Service</SelectItem>
          </SelectContent>
        </Select>

        <Select value={isActive} onValueChange={setIsActive}>
          <SelectTrigger className="w-[130px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="true">Active</SelectItem>
            <SelectItem value="false">Inactive</SelectItem>
          </SelectContent>
        </Select>

        <Button
          variant={lowStock ? undefined : "outline"}
          size="sm"
          onClick={() => setLowStock((v) => !v)}
        >
          <AlertTriangle className="h-3.5 w-3.5" /> Low stock
        </Button>

        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={() => { setType("all"); setLowStock(false); setIsActive("all"); t.setQ(""); }}>
            <X className="h-4 w-4" /> Clear
          </Button>
        )}
      </div>

      <DataTable
        columns={columns}
        data={data?.data}
        getRowId={(i) => i.id}
        total={data?.meta.total ?? 0}
        page={t.page}
        pageSize={t.pageSize}
        sort={t.sort}
        onPageChange={t.setPage}
        onPageSizeChange={t.setPageSize}
        onSortChange={t.handleSort}
        onRowClick={(i) => router.push(`/inventory/${i.id}`)}
        isLoading={isLoading}
        emptyMessage="No items found."
      />
    </div>
  );
}
