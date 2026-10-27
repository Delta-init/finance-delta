"use client";

import { useMemo } from "react";
import { useUrlFlag, useUrlPage, useUrlParam, useUrlText } from "@/lib/url-state";
import { useRouter } from "next/navigation";
import { Users2, TrendingUp, AlertTriangle } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MoneyDisplay } from "@/components/ui/money";
import { DataTable, type Column } from "@/components/ui/data-table";
import { usePeopleReport } from "@/features/payroll/api";
import type { PersonRow } from "@/features/payroll/types";

const monthStart = () => `${new Date().toISOString().slice(0, 7)}-01`;
const today = () => new Date().toISOString().slice(0, 10);

const STATUSES = ["active", "inactive", "all"] as const;
type StatusFilter = (typeof STATUSES)[number];
const SORTS = ["name", "invoiced", "payroll", "expenses", "cost", "owed"] as const;
type SortKey = (typeof SORTS)[number];
const sortValue: Record<SortKey, (r: PersonRow) => number | string> = {
  name: (r) => r.name.toLowerCase(),
  invoiced: (r) => r.invoicedMinor,
  payroll: (r) => r.payrollPaidMinor,
  expenses: (r) => r.expensesMinor,
  cost: (r) => r.totalCostMinor,
  owed: (r) => r.commissionOutstandingMinor,
};

/**
 * Everyone on the payroll, what they brought in and what they cost.
 *
 * Driven by the roster rather than by activity: the older salesperson report
 * groups invoices, so anybody who raised none had no row at all — right for
 * "who sold the most", wrong for "who works here". Somebody with no sales
 * appears here with zeroes.
 *
 * Cost is payroll paid plus expenses. Commission is shown as part of the
 * payroll figure and never added to it, because it reaches people as an
 * addition on a payroll run — adding it again would double every commission
 * payment.
 */
export default function SalespeoplePage() {
  const router = useRouter();
  // In the address bar (2026-10-22), so a refresh or a shared link keeps the same period and page.
  const [page, setPage] = useUrlPage();
  const [sizeParam, setSizeParam] = useUrlParam("size", "25");
  const pageSize = Number(sizeParam) || 25;
  const setPageSize = (n: number) => setSizeParam(String(n));
  const [search, setSearch, searched] = useUrlText("q");
  const [from, setFrom] = useUrlParam("from", monthStart());
  const [to, setTo] = useUrlParam("to", today());
  // 2026-10-27: those who left (65 of 169, two with the same name as a current record) made the list hard to pick
  // from — current staff by default. Sorted and filtered here, as the report sends everyone at once.
  const [status, setStatus] = useUrlParam<StatusFilter>("status", "active", { allowed: STATUSES });
  const [withSales, setWithSales] = useUrlFlag("sales");
  const [sortKey, setSortKey] = useUrlParam<SortKey>("sort", "name", { allowed: SORTS });
  const [sortDir, setSortDir] = useUrlParam<"asc" | "desc">("dir", "asc", { allowed: ["asc", "desc"] });

  const { data, isLoading, isPlaceholderData } = usePeopleReport({ from, to, search: searched.trim() || undefined });
  const currency = data?.currency ?? "AED";

  const filtered = useMemo(() => {
    const value = sortValue[sortKey];
    const sign = sortDir === "asc" ? 1 : -1;
    return (data?.rows ?? [])
      .filter((r) => status === "all" || r.status === status)
      .filter((r) => !withSales || r.invoiceCount > 0)
      .sort((a, b) => {
        const x = value(a), y = value(b);
        return (x < y ? -1 : x > y ? 1 : 0) * sign || a.name.localeCompare(b.name);
      });
  }, [data?.rows, status, withSales, sortKey, sortDir]);
  // The pager shows one page of them (it used to list all 169 on every page).
  const lastPage = Math.max(1, Math.ceil(filtered.length / pageSize));
  const shownPage = Math.min(page, lastPage);
  const rows = filtered.slice((shownPage - 1) * pageSize, shownPage * pageSize);
  const totals = useMemo(() => ({
    people: filtered.length,
    invoicedMinor: filtered.reduce((t, r) => t + r.invoicedMinor, 0),
    payrollPaidMinor: filtered.reduce((t, r) => t + r.payrollPaidMinor, 0),
    totalCostMinor: filtered.reduce((t, r) => t + r.totalCostMinor, 0),
  }), [filtered]);

  const onSort = (key: string) => {
    if (key === sortKey) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else {
      setSortKey(key as SortKey);
      // Money high to low first; names A to Z.
      setSortDir(key === "name" ? "asc" : "desc");
    }
  };

  const columns: Column<PersonRow>[] = [
    {
      key: "name",
      header: "Employee",
      sortable: true,
      cell: (r) => (
        <div>
          <div className="flex flex-wrap items-center gap-1.5 font-medium">
            {r.name}
            {r.onPayroll === false && <Badge tone="primary">Not on payroll</Badge>}
            {r.status === "inactive" && <Badge tone="neutral">{r.onPayroll === false ? "Suspended" : "Left"}</Badge>}
          </div>
          <div className="text-xs text-foreground-muted">
            {r.onPayroll === false ? "Named on invoices" : r.employeeCode}
            {r.designation ? ` · ${r.designation}` : ""}
          </div>
        </div>
      ),
    },
    {
      key: "department",
      header: "Department",
      cell: (r) =>
        r.departmentName ? (
          r.departmentName
        ) : r.onPayroll === false ? (
          <span className="text-foreground-muted">—</span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-xs text-warning">
            <AlertTriangle className="h-3.5 w-3.5" />Not mapped
          </span>
        ),
    },
    {
      key: "invoiced",
      header: "Invoiced",
      align: "right",
      sortable: true,
      cell: (r) =>
        r.invoiceCount ? (
          <div>
            <MoneyDisplay minor={r.invoicedMinor} currency={currency} />
            <div className="text-xs text-foreground-muted">{r.invoiceCount} invoice(s)</div>
          </div>
        ) : (
          <span className="text-foreground-muted">—</span>
        ),
    },
    {
      key: "payroll",
      header: "Payroll paid",
      align: "right",
      sortable: true,
      cell: (r) => (
        <div>
          <MoneyDisplay minor={r.payrollPaidMinor} currency={currency} />
          {r.commissionInPayrollMinor > 0 && (
            <div className="text-xs text-foreground-muted">
              incl. <MoneyDisplay minor={r.commissionInPayrollMinor} currency={currency} /> commission
            </div>
          )}
        </div>
      ),
    },
    {
      key: "expenses",
      header: "Expenses",
      align: "right",
      sortable: true,
      cell: (r) => <MoneyDisplay minor={r.expensesMinor} currency={currency} />,
    },
    {
      key: "cost",
      header: "Total cost",
      align: "right",
      sortable: true,
      cell: (r) => <MoneyDisplay minor={r.totalCostMinor} currency={currency} className="font-semibold" />,
    },
    {
      key: "owed",
      header: "Commission owed",
      align: "right",
      sortable: true,
      cell: (r) =>
        r.commissionOutstandingMinor > 0 ? (
          <Badge tone="warning">
            <TrendingUp className="mr-1 inline h-3 w-3" />
            <MoneyDisplay minor={r.commissionOutstandingMinor} currency={currency} />
          </Badge>
        ) : (
          <span className="text-foreground-muted">—</span>
        ),
    },
  ];

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        icon={Users2}
        title="Salespeople"
        description="Everyone on the payroll — all of them can be named on an invoice. What they brought in, and what they cost: payroll paid plus expenses, with commission already inside the payroll figure."
      />

      <Card className="flex flex-wrap items-end gap-3 p-3">
        <div className="space-y-1.5">
          <Label htmlFor="pp-search" className="text-xs">Search</Label>
          <Input
            id="pp-search"
            placeholder="Name, code or email"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full sm:w-56"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pp-from" className="text-xs">From</Label>
          <Input id="pp-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-[150px]" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pp-to" className="text-xs">To</Label>
          <Input id="pp-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-[150px]" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Status</Label>
          <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
            <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Current staff</SelectItem>
              <SelectItem value="inactive">Left</SelectItem>
              <SelectItem value="all">Everyone</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <label className="flex h-9 cursor-pointer items-center gap-2 text-sm">
          <Checkbox checked={withSales} onChange={() => setWithSales(!withSales)} aria-label="With sales only" />
          With sales only
        </label>
      </Card>

      {totals.people > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="People" value={String(totals.people)} />
          <Stat label="Invoiced" value={<MoneyDisplay minor={totals.invoicedMinor} currency={currency} />} />
          <Stat label="Payroll paid" value={<MoneyDisplay minor={totals.payrollPaidMinor} currency={currency} />} />
          <Stat label="Total cost" value={<MoneyDisplay minor={totals.totalCostMinor} currency={currency} />} strong />
        </div>
      )}

      <Card className="overflow-hidden">
        <DataTable
          columns={columns}
          data={rows}
          getRowId={(r) => r.employeeId}
          total={filtered.length}
          page={shownPage}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
          sort={{ key: sortKey, dir: sortDir }}
          onSortChange={onSort}
          isLoading={isLoading} isFetching={isPlaceholderData}
          onRowClick={(r) => router.push(`/reports/salesperson/${r.employeeId}?from=${from}&to=${to}`)}
          detailTitle={(r) => r.name}
          emptyMessage={
            data?.rows.length
              ? "Nobody here with these filters."
              : "Nobody is mapped yet. Link an organization under Payroll Mapping first."
          }
        />
      </Card>
    </div>
  );
}

function Stat({ label, value, strong }: { label: string; value: React.ReactNode; strong?: boolean }) {
  return (
    <Card className="p-4">
      <div className={strong ? "text-lg font-semibold" : "text-lg"}>{value}</div>
      <div className="mt-0.5 text-xs text-foreground-muted">{label}</div>
    </Card>
  );
}
