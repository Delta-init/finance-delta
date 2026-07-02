"use client";

import Link from "next/link";
import { ArrowLeft, BarChart3 } from "lucide-react";
import { type ValuationRow, ITEM_UNIT_LABELS, type ItemUnit } from "@delta/shared";
import { MoneyDisplay } from "@/components/ui/money";
import { DataTable, type Column } from "@/components/ui/data-table";
import { useTableQuery } from "@/lib/use-table-query";
import { useValuationReport } from "@/features/inventory/api";
import { useCurrency } from "@/lib/currency-context";

export default function ValuationPage() {
  const { currency: orgCurrency } = useCurrency();
  const { data: report, isLoading } = useValuationReport(orgCurrency);
  const t = useTableQuery({ initialSort: { key: "name", dir: "asc" } });

  const columns: Column<ValuationRow>[] = [
    {
      key: "itemNumber",
      header: "Item",
      sortable: true,
      cell: (row) => (
        <div>
          <p className="font-medium text-foreground">{row.name}</p>
          <p className="text-xs text-foreground-muted">{row.itemNumber} · {row.sku}</p>
        </div>
      ),
    },
    {
      key: "warehouseName",
      header: "Warehouse",
      cell: (row) => <span className="text-sm text-foreground-muted">{row.warehouseName}</span>,
    },
    {
      key: "unit",
      header: "Unit",
      cell: (row) => (
        <span className="text-sm text-foreground-muted">
          {ITEM_UNIT_LABELS[row.unit as ItemUnit] ?? row.unit}
        </span>
      ),
    },
    {
      key: "quantityOnHand",
      header: "Qty on Hand",
      align: "right",
      sortable: true,
      cell: (row) => <span className="font-medium">{row.quantityOnHand}</span>,
    },
    {
      key: "avgCostMinor",
      header: "Avg Cost",
      align: "right",
      sortable: true,
      cell: (row) => <MoneyDisplay minor={row.avgCostMinor} currency={orgCurrency} className="text-foreground-muted" />,
    },
    {
      key: "valuationMinor",
      header: "Valuation",
      align: "right",
      sortable: true,
      cell: (row) => <MoneyDisplay minor={row.valuationMinor} currency={orgCurrency} className="font-semibold" />,
    },
  ];

  return (
    <div className="space-y-4 p-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link
          href="/inventory"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-foreground-muted hover:bg-surface-muted hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="flex-1">
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <BarChart3 className="h-5 w-5 text-foreground-muted" /> Inventory Valuation
          </h1>
          <p className="text-sm text-foreground-muted">
            Stock value based on weighted average cost.
            {report?.asOf && (
              <span className="ml-2">As of {new Date(report.asOf).toLocaleDateString()}</span>
            )}
          </p>
        </div>
      </div>

      {/* Total */}
      {report && (
        <div className="rounded-lg border border-border bg-surface p-5 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-foreground-muted uppercase tracking-wide">Total Inventory Value</p>
            <MoneyDisplay
              minor={report.totalValueMinor}
              currency={orgCurrency}
              className="mt-1 text-2xl font-bold text-foreground"
            />
          </div>
          <div className="text-right text-sm text-foreground-muted">
            <p>{report.rows.length} line{report.rows.length !== 1 ? "s" : ""}</p>
            <p className="text-xs">{report.currency}</p>
          </div>
        </div>
      )}

      {/* Table */}
      <DataTable
        columns={columns}
        data={report?.rows}
        getRowId={(row) => `${row.itemId}-${row.warehouseId}`}
        total={report?.rows.length ?? 0}
        page={t.page}
        pageSize={t.pageSize}
        sort={t.sort}
        onPageChange={t.setPage}
        onPageSizeChange={t.setPageSize}
        onSortChange={t.handleSort}
        isLoading={isLoading}
        emptyMessage="No inventory to value. Add items and record stock first."
      />
    </div>
  );
}
