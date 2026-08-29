"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Building2 } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyDisplay } from "@/components/ui/money";
import { DataTable, type Column } from "@/components/ui/data-table";
import { useDepartmentReport } from "@/features/payroll/api";
import type { DepartmentSummary } from "@/features/payroll/types";

const monthStart = () => `${new Date().toISOString().slice(0, 7)}-01`;
const today = () => new Date().toISOString().slice(0, 10);

/** What each department earned and what it cost, with a way into its people. */
export default function DepartmentReportPage() {
  const router = useRouter();
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const { data, isLoading } = useDepartmentReport({ from, to });
  const rows = data?.departments ?? [];
  const currency = data?.currency ?? "AED";

  const columns: Column<DepartmentSummary>[] = [
    { key: "name", header: "Department", cell: (d) => <span className="font-medium">{d.name}</span> },
    { key: "headcount", header: "People", align: "right", cell: (d) => String(d.headcount) },
    { key: "invoiced", header: "Invoiced", align: "right", cell: (d) => <MoneyDisplay minor={d.invoicedMinor} currency={currency} /> },
    {
      key: "payroll",
      header: "Payroll paid",
      align: "right",
      cell: (d) => (
        <div>
          <MoneyDisplay minor={d.payrollPaidMinor} currency={currency} />
          {d.commissionInPayrollMinor > 0 && (
            <div className="text-xs text-foreground-muted">
              incl. <MoneyDisplay minor={d.commissionInPayrollMinor} currency={currency} /> commission
            </div>
          )}
        </div>
      ),
    },
    { key: "expenses", header: "Expenses", align: "right", cell: (d) => <MoneyDisplay minor={d.expensesMinor} currency={currency} /> },
    { key: "cost", header: "Total cost", align: "right", cell: (d) => <MoneyDisplay minor={d.totalCostMinor} currency={currency} className="font-semibold" /> },
  ];

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        icon={Building2}
        title="Departments"
        description="What each department earned and what it cost. Cost is payroll paid plus expenses; commission is already inside the payroll figure."
      />

      <Card className="flex flex-wrap items-end gap-3 p-3">
        <div className="space-y-1.5">
          <Label htmlFor="d-from" className="text-xs">From</Label>
          <Input id="d-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-[150px]" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="d-to" className="text-xs">To</Label>
          <Input id="d-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-[150px]" />
        </div>
      </Card>

      <Card className="overflow-hidden">
        <DataTable
          columns={columns}
          data={rows}
          getRowId={(d) => d.departmentId ?? "none"}
          total={rows.length}
          page={page}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
          isLoading={isLoading}
          // People with no department have no page to open — they are a bucket,
          // not a record.
          onRowClick={(d) => d.departmentId && router.push(`/reports/department/${d.departmentId}?from=${from}&to=${to}`)}
          detailTitle={(d) => d.name}
          emptyMessage="No departments yet."
        />
      </Card>
    </div>
  );
}
