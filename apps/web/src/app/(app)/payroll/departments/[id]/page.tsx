"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Building2 } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyDisplay } from "@/components/ui/money";
import { DataTable, type Column } from "@/components/ui/data-table";
import { usePeopleReport } from "@/features/payroll/api";
import type { PersonRow } from "@/features/payroll/types";

const monthStart = () => `${new Date().toISOString().slice(0, 7)}-01`;
const today = () => new Date().toISOString().slice(0, 10);

/** Everyone in one department, and what each of them earned and cost. */
export default function DepartmentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const search = useSearchParams();
  const [from, setFrom] = useState(search.get("from") ?? monthStart());
  const [to, setTo] = useState(search.get("to") ?? today());
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const { data, isLoading } = usePeopleReport({ from, to, departmentId: id });
  const rows = data?.rows ?? [];
  const totals = data?.totals;
  const currency = data?.currency ?? "AED";
  const name = rows[0]?.departmentName ?? "Department";

  const columns: Column<PersonRow>[] = [
    {
      key: "name",
      header: "Employee",
      cell: (r) => (
        <div>
          <div className="font-medium">{r.name}</div>
          <div className="text-xs text-foreground-muted">
            {r.employeeCode}{r.designation ? ` · ${r.designation}` : ""}
          </div>
        </div>
      ),
    },
    {
      key: "invoiced",
      header: "Invoiced",
      align: "right",
      cell: (r) => (r.invoiceCount ? <MoneyDisplay minor={r.invoicedMinor} currency={currency} /> : <span className="text-foreground-muted">—</span>),
    },
    { key: "payroll", header: "Payroll paid", align: "right", cell: (r) => <MoneyDisplay minor={r.payrollPaidMinor} currency={currency} /> },
    { key: "expenses", header: "Expenses", align: "right", cell: (r) => <MoneyDisplay minor={r.expensesMinor} currency={currency} /> },
    { key: "cost", header: "Total cost", align: "right", cell: (r) => <MoneyDisplay minor={r.totalCostMinor} currency={currency} className="font-semibold" /> },
  ];

  return (
    <div className="space-y-6 p-6">
      <Link href="/payroll/departments" className="inline-flex items-center gap-1.5 text-sm text-foreground-muted hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />All departments
      </Link>

      <PageHeader icon={Building2} title={name} description="Everyone in this department, and what each of them earned and cost." />

      <Card className="flex flex-wrap items-end gap-3 p-3">
        <div className="space-y-1.5">
          <Label htmlFor="dd-from" className="text-xs">From</Label>
          <Input id="dd-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-[150px]" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="dd-to" className="text-xs">To</Label>
          <Input id="dd-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-[150px]" />
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
          emptyMessage="Nobody is mapped to this department."
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
