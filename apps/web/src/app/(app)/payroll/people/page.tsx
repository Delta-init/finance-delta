"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Users2, TrendingUp, AlertTriangle } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyDisplay } from "@/components/ui/money";
import { DataTable, type Column } from "@/components/ui/data-table";
import { usePeopleReport } from "@/features/payroll/api";
import type { PersonRow } from "@/features/payroll/types";

const monthStart = () => `${new Date().toISOString().slice(0, 7)}-01`;
const today = () => new Date().toISOString().slice(0, 10);

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
export default function PayrollPeoplePage() {
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());

  const { data, isLoading } = usePeopleReport({ from, to, search: search.trim() || undefined });
  const rows = data?.rows ?? [];
  const totals = data?.totals;
  const currency = data?.currency ?? "AED";

  const columns: Column<PersonRow>[] = [
    {
      key: "name",
      header: "Employee",
      cell: (r) => (
        <div>
          <div className="font-medium">{r.name}</div>
          <div className="text-xs text-foreground-muted">
            {r.employeeCode}
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
      cell: (r) => <MoneyDisplay minor={r.expensesMinor} currency={currency} />,
    },
    {
      key: "cost",
      header: "Total cost",
      align: "right",
      cell: (r) => <MoneyDisplay minor={r.totalCostMinor} currency={currency} className="font-semibold" />,
    },
    {
      key: "owed",
      header: "Commission owed",
      align: "right",
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
        title="People on payroll"
        description="Everyone mapped from HRMS, what they brought in and what they cost. Cost is payroll paid plus expenses; commission is already inside the payroll figure."
      />

      <Card className="flex flex-wrap items-end gap-3 p-3">
        <div className="space-y-1.5">
          <Label htmlFor="pp-search" className="text-xs">Search</Label>
          <Input
            id="pp-search"
            placeholder="Name, code or email"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
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
      </Card>

      {totals && totals.people > 0 && (
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
          total={rows.length}
          page={page}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
          isLoading={isLoading}
          onRowClick={(r) => router.push(`/payroll/people/${r.employeeId}?from=${from}&to=${to}`)}
          detailTitle={(r) => r.name}
          emptyMessage="Nobody is mapped yet. Link an organization under Payroll Mapping first."
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
