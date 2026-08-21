"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Search, ReceiptText, X, Repeat, PauseCircle, Pencil, Trash2, Tag } from "lucide-react";
import { type Expense } from "@delta/shared";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { MoneyDisplay } from "@/components/ui/money";
import { useTableQuery } from "@/lib/use-table-query";
import { useExpenses, useVoidExpense } from "@/features/expenses/api";
import { useExpenseCategories } from "@/features/expense-categories/api";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";

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

function DeleteExpenseDialog({ expense, onClose }: { expense: Expense; onClose: () => void }) {
  const voidExpense = useVoidExpense(expense.id);
  async function handleVoid() {
    try {
      await voidExpense.mutateAsync(undefined);
      toast.success("Expense deleted");
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to delete expense");
    }
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Delete expense?</DialogTitle></DialogHeader>
        <p className="text-sm text-foreground-muted">
          This voids <span className="font-medium text-foreground">{expense.expenseNumber}</span>
          {expense.description ? ` — ${expense.description}` : ""}. It stays in history for audit but no longer counts toward totals.
        </p>
        <DialogFooter>
          <DialogClose asChild><Button type="button" variant="ghost">Cancel</Button></DialogClose>
          <Button variant="destructive" onClick={handleVoid} loading={voidExpense.isPending}>Delete expense</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function ExpensesPage() {
  const router = useRouter();
  const t = useTableQuery({ initialSort: { key: "date", dir: "desc" } });
  const [voidTarget, setVoidTarget] = useState<Expense | null>(null);
  const { data: categoryList } = useExpenseCategories();
  const [status, setStatus] = useState("all");
  const [category, setCategory] = useState("all");
  const [recurring, setRecurring] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  useEffect(() => t.resetPage(), [status, category, recurring, dateFrom, dateTo]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data, isLoading } = useExpenses({
    ...t.baseParams,
    status: status === "all" ? undefined : status,
    category: category === "all" ? undefined : category,
    isRecurring: recurring === "all" ? undefined : recurring === "recurring" ? "true" : "false",
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
  });

  const hasFilters = status !== "all" || category !== "all" || recurring !== "all" || dateFrom || dateTo || !!t.q;

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
      cell: (e) => (
        <div className="flex items-center gap-2">
          <span className="max-w-xs truncate">{e.description}</span>
          {e.isRecurring && (
            e.recurrence?.isActive === false ? (
              <Badge tone="neutral" className="shrink-0 gap-1">
                <PauseCircle className="h-3 w-3" /> Paused
              </Badge>
            ) : (
              <Badge tone="primary" className="shrink-0 gap-1 capitalize">
                <Repeat className="h-3 w-3" /> {e.recurrence?.frequency ?? "recurring"}
              </Badge>
            )
          )}
        </div>
      ),
    },
    {
      key: "category",
      header: "Category",
      sortable: true,
      cell: (e) => <span className="text-foreground-muted">{e.categoryName || e.category}</span>,
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
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (e) => (
        <div className="flex items-center justify-end gap-1" onClick={(ev) => ev.stopPropagation()}>
          {(e.status === "draft" || e.status === "rejected") && (
            <button
              type="button"
              title="Edit"
              onClick={() => router.push(`/expenses/${e.id}/edit`)}
              className="rounded p-1.5 text-foreground-muted hover:bg-surface-muted hover:text-foreground"
            >
              <Pencil className="h-4 w-4" />
            </button>
          )}
          {e.status !== "voided" && (
            <button
              type="button"
              title="Delete"
              onClick={() => setVoidTarget(e)}
              className="rounded p-1.5 text-foreground-muted hover:bg-danger/10 hover:text-danger"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4 p-6">
      <PageHeader
        icon={ReceiptText}
        title="Expenses"
        description="Track and manage business expenses."
        action={
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => router.push("/expenses/categories")}>
              <Tag className="h-4 w-4" /> Categories
            </Button>
            <Button variant="outline" onClick={() => router.push("/expenses/recurring")}>
              <Repeat className="h-4 w-4" /> Recurring
            </Button>
            <Button onClick={() => router.push("/expenses/new")}>
              <Plus className="h-4 w-4" /> New expense
            </Button>
          </div>
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
            {(categoryList ?? []).map((c) => (
              <SelectItem key={c.slug} value={c.slug}>{c.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={recurring} onValueChange={setRecurring}>
          <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All expenses</SelectItem>
            <SelectItem value="recurring">Recurring only</SelectItem>
            <SelectItem value="oneoff">One-off only</SelectItem>
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

      {voidTarget && <DeleteExpenseDialog expense={voidTarget} onClose={() => setVoidTarget(null)} />}
    </div>
  );
}
