"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Search, ReceiptText, X } from "lucide-react";
import { formatMoney, type Expense, EXPENSE_CATEGORY_LABELS, type ExpenseCategory } from "@delta/shared";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MoneyDisplay } from "@/components/ui/money";
import { useTableQuery } from "@/lib/use-table-query";
import { useExpenses } from "@/features/expenses/api";

const STATUS_TONE: Record<string, NonNullable<BadgeProps["tone"]>> = {
  draft: "neutral",
  submitted: "warning",
  approved: "success",
  rejected: "danger",
  voided: "neutral",
};

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  submitted: "Submitted",
  approved: "Approved",
  rejected: "Rejected",
  voided: "Voided",
};

const CATEGORIES = [
  { value: "salaries_wages", label: "Salaries & Wages" },
  { value: "commissions", label: "Commissions" },
  { value: "rent", label: "Rent" },
  { value: "utilities", label: "Utilities" },
  { value: "travel", label: "Travel" },
  { value: "marketing", label: "Marketing" },
  { value: "other", label: "Other" },
] as const;

export default function ExpensesPage() {
  const router = useRouter();
  const t = useTableQuery({ initialSort: { key: "date", dir: "desc" } });
  const [status, setStatus] = useState("all");
  const [category, setCategory] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  useEffect(() => t.resetPage(), [status, category, dateFrom, dateTo]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data, isLoading } = useExpenses({
    ...t.baseParams,
    status: status === "all" ? undefined : status,
    category: category === "all" ? undefined : category,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
  });

  const hasFilters = status !== "all" || category !== "all" || dateFrom || dateTo || !!t.q;

  const columns: Column<Expense>[] = [
    {
      key: "number",
      header: "Expense #",
      sortable: true,
      cell: (e) => <span className="font-medium text-primary">{e.expenseNumber}</span>,
    },
    {
      key: "description",
      header: "Description",
      sortable: true,
      cell: (e) => <span className="max-w-xs truncate block">{e.description}</span>,
    },
    {
      key: "category",
      header: "Category",
      sortable: true,
      cell: (e) => (
        <span className="text-foreground-muted">
          {EXPENSE_CATEGORY_LABELS[e.category as ExpenseCategory] ?? e.category}
        </span>
      ),
    },
    {
      key: "date",
      header: "Date",
      sortable: true,
      cell: (e) => <span className="text-foreground-muted">{e.expenseDate}</span>,
    },
    {
      key: "submittedBy",
      header: "Submitted By",
      sortable: true,
      cell: (e) => <span className="text-foreground-muted">{e.submittedByName}</span>,
    },
    {
      key: "status",
      header: "Status",
      sortable: true,
      cell: (e) => (
        <Badge tone={STATUS_TONE[e.status] ?? "neutral"}>
          {STATUS_LABELS[e.status] ?? e.status}
        </Badge>
      ),
    },
    {
      key: "total",
      header: "Total",
      align: "right",
      sortable: true,
      cell: (e) => <MoneyDisplay minor={e.totalMinor} currency={e.currency} className="font-medium" />,
    },
  ];

  return (
    <div className="space-y-4 p-6">
      <PageHeader
        icon={ReceiptText}
        title="Expenses"
        description="Track and manage business expenses."
        action={
          <Button onClick={() => router.push("/expenses/new")}>
            <Plus className="h-4 w-4" /> New expense
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-3">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle" />
          <Input value={t.q} onChange={(e) => t.setQ(e.target.value)} placeholder="Search expenses…" className="pl-8" />
        </div>

        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {Object.entries(STATUS_LABELS).map(([k, v]) => (
              <SelectItem key={k} value={k}>{v}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {CATEGORIES.map((c) => (
              <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Input
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          className="w-[140px]"
        />
        <Input
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          className="w-[140px]"
        />

        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { setStatus("all"); setCategory("all"); setDateFrom(""); setDateTo(""); t.setQ(""); }}
          >
            <X className="h-4 w-4" /> Clear
          </Button>
        )}
      </div>

      <DataTable
        columns={columns}
        data={data?.data}
        getRowId={(e) => e.id}
        total={data?.meta.total ?? 0}
        page={t.page}
        pageSize={t.pageSize}
        sort={t.sort}
        onPageChange={t.setPage}
        onPageSizeChange={t.setPageSize}
        onSortChange={t.handleSort}
        onRowClick={(e) => router.push(`/expenses/${e.id}`)}
        isLoading={isLoading}
        emptyMessage="No expenses found."
      />
    </div>
  );
}
