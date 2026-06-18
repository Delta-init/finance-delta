"use client";

import { useState } from "react";
import { FileBarChart, ArrowLeft } from "lucide-react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { MoneyDisplay } from "@/components/ui/money";
import { DataTable, type Column } from "@/components/ui/data-table";
import { useSalesByItem, useExpenseByCategory } from "@/features/reports/api";
import type { SalesItemRow, ExpenseCategoryRow } from "@delta/shared";

function today() { return new Date().toISOString().slice(0, 10); }
function yearStart() { return `${new Date().getFullYear()}-01-01`; }

const EXPENSE_CATEGORY_LABELS: Record<string, string> = {
  salaries_wages: "Salaries & Wages",
  commissions: "Commissions",
  rent: "Rent",
  utilities: "Utilities",
  travel: "Travel",
  marketing: "Marketing",
  other: "Other",
};

export default function OtherReportsPage() {
  const router = useRouter();
  const [from, setFrom] = useState(yearStart());
  const [to, setTo] = useState(today());

  const { data: salesData, isLoading: salesLoading } = useSalesByItem(from, to);
  const { data: expenseData, isLoading: expenseLoading } = useExpenseByCategory(from, to);

  const salesColumns: Column<SalesItemRow>[] = [
    { key: "description", header: "Item / Description", sortable: true, cell: (r) => <>{r.description}</> },
    {
      key: "qty",
      header: "Qty Sold",
      align: "right",
      sortable: true,
      cell: (r) => <span className="font-medium">{r.qty.toLocaleString()}</span>,
    },
    {
      key: "avgPriceMinor",
      header: "Avg Price",
      align: "right",
      sortable: true,
      cell: (r) => <MoneyDisplay minor={r.avgPriceMinor} className="text-foreground-muted" />,
    },
    {
      key: "revenueMinor",
      header: "Revenue",
      align: "right",
      sortable: true,
      cell: (r) => <MoneyDisplay minor={r.revenueMinor} className="font-semibold" />,
    },
  ];

  const expenseColumns: Column<ExpenseCategoryRow>[] = [
    {
      key: "category",
      header: "Category",
      sortable: true,
      cell: (r) => <span>{EXPENSE_CATEGORY_LABELS[r.category] ?? r.category}</span>,
    },
    {
      key: "count",
      header: "# Expenses",
      align: "right",
      sortable: true,
      cell: (r) => <>{r.count}</>,
    },
    {
      key: "totalMinor",
      header: "Total",
      align: "right",
      sortable: true,
      cell: (r) => <MoneyDisplay minor={r.totalMinor} className="font-semibold" />,
    },
    {
      key: "pct",
      header: "% of Total",
      align: "right",
      cell: (r) => {
        const grand = expenseData?.grandTotalMinor ?? 0;
        const pct = grand > 0 ? Math.round((r.totalMinor / grand) * 100) : 0;
        return (
          <div className="flex items-center justify-end gap-2">
            <div className="h-1.5 w-16 rounded-full bg-surface-muted overflow-hidden">
              <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
            </div>
            <span className="text-foreground-muted text-xs w-7 text-right">{pct}%</span>
          </div>
        );
      },
    },
  ];

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        icon={FileBarChart}
        title="Other Reports"
        description="Sales by item, expense by category, and more."
        action={
          <Button variant="outline" onClick={() => router.push("/reports")}>
            <ArrowLeft className="h-4 w-4" /> All reports
          </Button>
        }
      />

      {/* Date filter */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-3">
        <span className="text-sm text-foreground-muted">Period:</span>
        <DatePicker value={from} onChange={setFrom} placeholder="From" />
        <span className="text-foreground-subtle">→</span>
        <DatePicker value={to} onChange={setTo} placeholder="To" />
      </div>

      {/* Sales by item */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Sales by Item</h2>
          {salesData && (
            <div className="text-sm text-foreground-muted">
              Total: <MoneyDisplay minor={salesData.grandTotalMinor} className="font-semibold text-foreground" />
            </div>
          )}
        </div>
        <DataTable
          columns={salesColumns}
          data={salesData?.items ?? []}
          getRowId={(r) => r.itemId ?? r.description}
          total={salesData?.items.length ?? 0}
          page={1}
          pageSize={salesData?.items.length || 10}
          onPageChange={() => {}}
          onPageSizeChange={() => {}}
          isLoading={salesLoading}
          emptyMessage="No sales data for this period."
        />
      </section>

      {/* Expense by category */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Expense by Category</h2>
          {expenseData && (
            <div className="text-sm text-foreground-muted">
              Total: <MoneyDisplay minor={expenseData.grandTotalMinor} className="font-semibold text-foreground" />
            </div>
          )}
        </div>
        <DataTable
          columns={expenseColumns}
          data={expenseData?.categories ?? []}
          getRowId={(r) => r.category}
          total={expenseData?.categories.length ?? 0}
          page={1}
          pageSize={expenseData?.categories.length || 10}
          onPageChange={() => {}}
          onPageSizeChange={() => {}}
          isLoading={expenseLoading}
          emptyMessage="No expense data for this period."
        />
      </section>
    </div>
  );
}
