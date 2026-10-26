"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Plus, Search, ReceiptText, X, Repeat, PauseCircle, Pencil, Trash2, Tag } from "lucide-react";
import { type Expense, EXPENSE_PAYMENT_STATUS_LABELS, expensePaymentMethodSchema, paymentMethodLabel } from "@delta/shared";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { MoneyDisplay } from "@/components/ui/money";
import { useTableQuery } from "@/lib/use-table-query";
import { countFilters, useUrlParam } from "@/lib/url-state";
import { FilterToggle } from "@/components/ui/filter-toggle";
import { DateRangeQuick, useUrlDateRange } from "@/components/ui/date-range-quick";
import { useExpenses, useVoidExpense, useDeleteExpense, useExpenseSummary } from "@/features/expenses/api";
import { ExpenseSummaryCards } from "@/features/expenses/ExpenseSummaryCards";
import { BankAccountFilter, PaymentMethodFilter } from "@/features/banking/PaymentFilters";
import { useExpenseCategories } from "@/features/expense-categories/api";
import { subcategoriesOf } from "@/features/expense-categories/CategoryPicker";
import { useUsers, EVERYONE } from "@/features/users/api";
import { ExportButton } from "@/components/ui/export-button";
import type { ExportColumn } from "@/lib/export";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useCan } from "@/lib/use-can";

const STATUS_TONE: Record<string, NonNullable<BadgeProps["tone"]>> = {
  draft: "neutral",
  submitted: "warning",
  approved: "success",
  rejected: "danger",
  voided: "neutral",
};

/**
 * Whether the money went out, which the approval status does not say.
 *
 * Kept visually distinct from the approval badge beside it: paid is the quiet
 * one, because a settled claim needs no attention, and overdue is the loud one.
 */
const PAYMENT_TONE: Record<string, NonNullable<BadgeProps["tone"]>> = {
  unpaid: "warning",
  overdue: "danger",
  paid: "success",
};

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  submitted: "Submitted",
  approved: "Approved",
  rejected: "Rejected",
  voided: "Voided",
};

const EXPENSE_EXPORT_COLUMNS: ExportColumn<Expense>[] = [
  { header: "Expense #", value: (e) => e.expenseNumber },
  { header: "Description", value: (e) => e.description },
  { header: "Category", value: (e) => e.categoryName || e.category },
  { header: "Subcategory", value: (e) => e.subcategoryName ?? "" },
  { header: "Date", value: (e) => e.expenseDate },
  { header: "Statement date", value: (e) => e.statementDate ?? (e.statementState === "pending" ? "Pending" : "") },
  { header: "Submitted By", value: (e) => e.submittedByName },
  { header: "Salesperson", value: (e) => e.salesperson?.name ?? "" },
  { header: "Status", value: (e) => (e.awaitingPayment ? "Waiting for payment" : STATUS_LABELS[e.status] ?? e.status) },
  { header: "Paid by", value: (e) => paymentMethodLabel(e.paymentMethod) },
  { header: "Bank", value: (e) => e.paymentAccount ?? "" },
  { header: "Bill", value: (e) => e.bill?.number ?? "" },
  { header: "Currency", value: (e) => e.currency },
  { header: "Total", value: (e) => e.totalMinor / 100 },
];

/*
 * Void or delete (the user, 2026-10-16). This used to be called Delete and
 * only voided; now both are offered and named for what they do: voiding keeps
 * it on the record as cancelled, deleting removes it for good (one from HRMS
 * or payroll keeps its number, so the server refuses that and says to void).
 */
function DeleteExpenseDialog({ expense, onClose }: { expense: Expense; onClose: () => void }) {
  const voidExpense = useVoidExpense(expense.id);
  const deleteExpense = useDeleteExpense();
  async function run(kind: "void" | "delete") {
    try {
      if (kind === "void") await voidExpense.mutateAsync(undefined);
      else await deleteExpense.mutateAsync(expense.id);
      toast.success(kind === "void" ? `${expense.expenseNumber} voided` : `${expense.expenseNumber} deleted`);
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : kind === "void" ? "Could not void this expense" : "Could not delete this expense");
    }
  }
  const voided = expense.status === "voided";
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{voided ? "Delete" : "Void or delete"} {expense.expenseNumber}?</DialogTitle></DialogHeader>
        <p className="text-sm text-foreground-muted">
          <span className="font-medium text-foreground">{expense.expenseNumber}</span>
          {expense.description ? ` — ${expense.description}` : ""}.{" "}
          {voided ? "" : "Void keeps it on the record as cancelled, out of the totals. "}
          Delete removes it for good, with its receipts. This cannot be undone.
        </p>
        <DialogFooter>
          <DialogClose asChild><Button type="button" variant="ghost">Cancel</Button></DialogClose>
          {!voided && <Button variant="secondary" onClick={() => void run("void")} loading={voidExpense.isPending}>Void</Button>}
          <Button variant="destructive" onClick={() => void run("delete")} loading={deleteExpense.isPending}>Delete for good</Button>
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
  // Every filter in the address bar (2026-10-22).
  const [status, setStatus] = useUrlParam("status", "all");
  const [payment, setPayment] = useUrlParam("payment", "all");
  const [category, setCategory] = useUrlParam("category", "all");
  // One of the chosen category's subcategories (2026-10-21); a new category starts from all of them.
  const [subcategory, setSubcategory] = useUrlParam("subcategory", "all");
  const pickCategory = (v: string) => { setCategory(v); setSubcategory("all"); };
  const subOptions = category === "all" ? [] : subcategoriesOf(categoryList, category);
  const [recurring, setRecurring] = useUrlParam("recurring", "all");
  // When it was spent: Today, This week, This month, Last 30 days or Custom (2026-10-22) — beside the search.
  const spent = useUrlDateRange({ fromKey: "from", toKey: "to" });
  const dateFrom = spent.from, dateTo = spent.to;
  // One salesperson's expenses (2026-10-21) — also from a link (?salespersonId=), as the expense page gives.
  const [salesperson, setSalesperson] = useUrlParam("salespersonId", "all");
  // How it was paid and from which account (2026-10-22).
  const [paymentMethod, setPaymentMethod] = useUrlParam("paidBy", "");
  const [bankAccountId, setBankAccountId] = useUrlParam("bank", "");
  // Where it came from (2026-10-23): typed here, a bill, HRMS, or the old books.
  const [source, setSource] = useUrlParam("source", "all");
  // Its bank statement date (2026-10-23): entered when the account is reconciled, or still pending.
  const [statement, setStatement] = useUrlParam("statement", "all");
  // …or the days the bank statement shows them (2026-10-23), in the Filters panel beside the rest.
  const stmt = useUrlDateRange({ fromKey: "stmtFrom", toKey: "stmtTo", rangeKey: "stmtRange" });
  const [filtersOpen, setFiltersOpen] = useState(false);
  const canPickSalesperson = useCan().can("user:read");
  const { data: userList } = useUsers({ pageSize: EVERYONE, sort: "name", dir: "asc" }, { enabled: canPickSalesperson });

  // One set of filters for the table and its export, so the export is always what the table shows (2026-10-18).
  const listParams = {
    ...t.baseParams,
    status: status === "all" ? undefined : status,
    paymentStatus: payment === "all" ? undefined : payment,
    category: category === "all" ? undefined : category,
    subcategory: category === "all" || subcategory === "all" ? undefined : subcategory,
    isRecurring: recurring === "all" ? undefined : recurring === "recurring" ? "true" : "false",
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    salespersonId: salesperson === "all" ? undefined : salesperson,
    paymentMethod: paymentMethod || undefined,
    bankAccountId: bankAccountId || undefined,
    source: source === "all" ? undefined : source,
    statement: statement === "all" ? undefined : statement,
    statementFrom: stmt.from || undefined,
    statementTo: stmt.to || undefined,
  };
  const { data, isLoading, isPlaceholderData } = useExpenses(listParams);
  // The cards above the table: what these same filters match, per currency (2026-10-21).
  const summary = useExpenseSummary(listParams);

  // The range is on show beside the search, so the button counts the rest.
  const filterCount = countFilters(status, payment, category, subcategory, recurring, salesperson, paymentMethod, bankAccountId, source, statement, stmt.range);
  const hasFilters = filterCount > 0 || spent.range !== "all" || !!t.q;

  // True when this person only ever sees their own claims.
  const ownOnly = useCan().ownOnly("expense:read", "expense:read:own");
  // Voiding and deleting are both the expense's delete right, as on the server.
  const canRemove = useCan().can("expense:delete");

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
      cell: (e) => (
        <span className="text-foreground-muted">
          {e.categoryName || e.category}
          {e.subcategoryName && <span className="block text-xs">{e.subcategoryName}</span>}
        </span>
      ),
    },
    {
      // Who the expense is for, when it is for a salesperson (2026-10-21) — a click lists just theirs.
      key: "salesperson",
      header: "Salesperson",
      cell: (e) =>
        e.salesperson ? (
          <button
            type="button"
            onClick={(ev) => { ev.stopPropagation(); setSalesperson(e.salesperson!.id); }}
            className="text-left hover:underline"
            title={`Only ${e.salesperson.name}'s expenses`}
          >
            {e.salesperson.name}
          </button>
        ) : (
          <span className="text-foreground-subtle">—</span>
        ),
    },
    {
      key: "date",
      header: "Date",
      sortable: true,
      cell: (e) => <span className="text-foreground-muted">{e.expenseDate}</span>,
    },
    // The day the bank statement shows it — entered when the account is reconciled (2026-10-23).
    {
      key: "statementDate",
      header: "Statement date",
      sortable: true,
      cell: (e) => e.statementDate
        ? <span className="text-foreground-muted">{e.statementDate}</span>
        : e.statementState === "pending"
          ? <Badge tone="warning" title="Set when its bank account is reconciled">Pending</Badge>
          : <span className="text-foreground-subtle">—</span>,
    },
    // Dropped for somebody who only ever sees their own: a column repeating
    // the reader's own name on every row is a column of no information.
    ...(ownOnly
      ? []
      : [
          {
            key: "submittedBy",
            header: "Submitted By",
            sortable: true,
            cell: (e: Expense) => <span className="text-foreground-muted">{e.submittedByName}</span>,
          },
        ]),
    {
      key: "status",
      header: "Status",
      sortable: true,
      cell: (e) => (
        // An approved purchase request not paid yet is a draft that waits for its payment, not an approver (2026-10-26).
        e.awaitingPayment
          ? <Badge tone="warning">Waiting for payment</Badge>
          : <Badge tone={STATUS_TONE[e.status] ?? "neutral"}>{STATUS_LABELS[e.status] ?? e.status}</Badge>
      ),
    },
    {
      key: "payment",
      header: "Payment",
      cell: (e) => (
        <div className="flex flex-col gap-0.5">
          <Badge tone={PAYMENT_TONE[e.paymentStatus] ?? "neutral"} className="w-fit">
            {EXPENSE_PAYMENT_STATUS_LABELS[e.paymentStatus] ?? e.paymentStatus}
          </Badge>
          {/* The date that explains the badge: what it was settled on, or what
              it is being measured against. */}
          {e.paidOn ? (
            <span className="text-xs text-foreground-muted">{e.paidOn}</span>
          ) : e.dueDate ? (
            <span className="text-xs text-foreground-muted">due {e.dueDate}</span>
          ) : null}
        </div>
      ),
    },
    // How it was paid and from which account (2026-10-22); "—" when it says none.
    {
      key: "paidBy",
      header: "Paid by",
      cell: (e) => <span className="text-foreground-muted">{paymentMethodLabel(e.paymentMethod) || "—"}</span>,
    },
    {
      key: "bank",
      header: "Bank",
      cell: (e) => <span className="text-foreground-muted">{e.paymentAccount || "—"}</span>,
    },
    // The bill it is, when it is one (2026-10-23).
    {
      key: "bill",
      header: "Bill",
      cell: (e) => e.bill
        ? <Link href={`/bills/${e.bill.id}`} onClick={(ev) => ev.stopPropagation()} className="text-primary hover:underline">{e.bill.number}</Link>
        : <span className="text-foreground-subtle">—</span>,
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
          {/* A bill's own expense is changed on its bill. */}
          {!e.bill && e.status !== "voided" && (
            <button
              type="button"
              title="Edit"
              onClick={() => router.push(`/expenses/${e.id}/edit`)}
              className="rounded p-1.5 text-foreground-muted hover:bg-surface-muted hover:text-foreground"
            >
              <Pencil className="h-4 w-4" />
            </button>
          )}
          {canRemove && !e.bill && (
            <button
              type="button"
              title={e.status === "voided" ? "Delete" : "Void or delete"}
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
            <FilterToggle open={filtersOpen} onToggle={() => setFiltersOpen((o) => !o)} count={filterCount} />
            <ExportButton
              resource="expenses"
              params={listParams}
              columns={EXPENSE_EXPORT_COLUMNS}
              filename="expenses"
              title="Expenses"
              size="md"
            />
            {/* Managing categories reads them org-wide, which somebody scoped
                to their own claims cannot do. Recurring is fine — it lists
                their own. */}
            {!ownOnly && (
              <Button variant="outline" onClick={() => router.push("/expenses/categories")}>
                <Tag className="h-4 w-4" /> Categories
              </Button>
            )}
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
        <DateRangeQuick value={spent} />

        {/* The rest only once Filters is pressed (2026-10-22); the search stays out. */}
        {filtersOpen && (<>

        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {Object.entries(STATUS_LABELS).map(([k, v]) => (
              <SelectItem key={k} value={k}>{v}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={payment} onValueChange={setPayment}>
          <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Paid & unpaid</SelectItem>
            {Object.entries(EXPENSE_PAYMENT_STATUS_LABELS).map(([k, v]) => (
              <SelectItem key={k} value={k}>{v}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={category} onValueChange={pickCategory}>
          <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {(categoryList ?? []).map((c) => (
              <SelectItem key={c.slug} value={c.slug}>{c.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        {subOptions.length > 0 && (
          <Select value={subcategory} onValueChange={setSubcategory}>
            <SelectTrigger className="w-[180px]" aria-label="Subcategory"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All subcategories</SelectItem>
              {subOptions.map((s) => <SelectItem key={s.slug} value={s.slug}>{s.name}</SelectItem>)}
            </SelectContent>
          </Select>
        )}

        {canPickSalesperson && (
          <Select value={salesperson} onValueChange={setSalesperson}>
            <SelectTrigger className="w-[170px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All salespeople</SelectItem>
              {(userList?.data ?? []).map((u) => (
                <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <Select value={recurring} onValueChange={setRecurring}>
          <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All expenses</SelectItem>
            <SelectItem value="recurring">Recurring only</SelectItem>
            <SelectItem value="oneoff">One-off only</SelectItem>
          </SelectContent>
        </Select>

        <PaymentMethodFilter methods={expensePaymentMethodSchema.options} value={paymentMethod} onChange={setPaymentMethod} anyLabel="All payment methods" />
        <Select value={source} onValueChange={setSource}>
          <SelectTrigger className="w-[150px]" aria-label="Source"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sources</SelectItem>
            <SelectItem value="typed">Typed here</SelectItem>
            <SelectItem value="bill">From bills</SelectItem>
            <SelectItem value="hrms">From HRMS</SelectItem>
            <SelectItem value="import">Old books</SelectItem>
          </SelectContent>
        </Select>
        <BankAccountFilter value={bankAccountId} onChange={setBankAccountId} anyLabel="All bank accounts" />
        <Select value={statement} onValueChange={setStatement}>
          <SelectTrigger className="w-[170px]" aria-label="Statement date"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any statement date</SelectItem>
            <SelectItem value="pending">Statement date pending</SelectItem>
            <SelectItem value="entered">Statement date entered</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex w-full flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-foreground-muted">Statement date</span>
          <DateRangeQuick value={stmt} />
          {stmt.range !== "all" && <span className="text-xs text-foreground-subtle">Only expenses reconciled with a statement date — pending and cash ones are left out</span>}
        </div>

        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setStatus("all");
              setPaymentMethod("");
              setBankAccountId("");
              setSource("all");
              setStatement("all");
              stmt.setRange("all");
              setPayment("all");
              pickCategory("all");
              // Counted by hasFilters, so it put the Clear button on screen and
              // was then the one thing the button did not clear.
              setRecurring("all");
              spent.setRange("all");
              setSalesperson("all");
              t.setQ("");
            }}
          >
            <X className="h-4 w-4" /> Clear
          </Button>
        )}
        </>)}
      </div>

      {/* An API from before the cards answers 404: the page then simply has none. */}
      {!summary.error && <ExpenseSummaryCards summary={summary.data} loading={summary.isLoading} refreshing={summary.isPlaceholderData} />}

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
        isLoading={isLoading} isFetching={isPlaceholderData}
        emptyMessage="No expenses found."
      />

      {voidTarget && <DeleteExpenseDialog expense={voidTarget} onClose={() => setVoidTarget(null)} />}
    </div>
  );
}
