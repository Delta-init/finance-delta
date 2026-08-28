"use client";

import { useState } from "react";
import { Users2, TrendingUp, AlertTriangle } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { MoneyDisplay } from "@/components/ui/money";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataTable, type Column } from "@/components/ui/data-table";
import { useMappedEmployees } from "@/features/payroll-mapping/api";
import type { MappedEmployee } from "@/features/payroll-mapping/types";

/**
 * Who payroll knows about, and which of them are salespeople.
 *
 * The two are not the same set, and the page says so rather than leaving it to
 * be inferred: everybody here is mapped from HRMS and will appear on a payroll
 * run, but only those holding a finance login with a commission structure
 * against it can earn commission. On a typical payroll that is a small
 * minority, and the "Salespeople" filter is how you see just them.
 */
export default function PayrollPeoplePage() {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [search, setSearch] = useState("");
  const [role, setRole] = useState("");
  const [status, setStatus] = useState("");

  const { data, isLoading } = useMappedEmployees({
    page,
    limit: pageSize,
    search: search.trim() || undefined,
    role: role || undefined,
    status: status || undefined,
  });

  const rows = data?.data ?? [];
  const salespeople = rows.filter((r) => r.isSalesperson).length;

  const columns: Column<MappedEmployee>[] = [
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
    { key: "department", header: "Department", cell: (r) => r.department ?? <span className="text-foreground-muted">—</span> },
    {
      key: "role",
      header: "Role",
      cell: (r) =>
        r.isSalesperson ? (
          <Badge tone="primary">
            <TrendingUp className="mr-1 inline h-3 w-3" />Salesperson
          </Badge>
        ) : (
          <span className="text-foreground-muted">Payroll only</span>
        ),
    },
    {
      key: "commission",
      header: "Commission owed",
      align: "right",
      cell: (r) =>
        r.isSalesperson ? (
          <div>
            <MoneyDisplay minor={r.commissionEarnedMinor} />
            {r.commissionPaidMinor > 0 && (
              <div className="text-xs text-foreground-muted">
                <MoneyDisplay minor={r.commissionPaidMinor} /> paid
              </div>
            )}
          </div>
        ) : (
          <span className="text-foreground-muted">—</span>
        ),
    },
    {
      key: "payable",
      header: "Payable",
      cell: (r) =>
        r.status !== "active" ? (
          <Badge tone="neutral">Inactive</Badge>
        ) : r.payable ? (
          <Badge tone="success">Ready</Badge>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-xs text-warning">
            <AlertTriangle className="h-3.5 w-3.5" />
            {!r.hasBankDetails ? "No bank details" : "No department"}
          </span>
        ),
    },
  ];

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        icon={Users2}
        title="People on payroll"
        description="Everyone mapped from HRMS. Salespeople are the ones who can also earn commission."
      />

      <Card className="flex flex-wrap items-center gap-2 p-3">
        <Input
          placeholder="Search name, code or email"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          className="w-full sm:w-64"
        />
        <Select value={role} onValueChange={(v) => { setRole(v); setPage(1); }}>
          <SelectTrigger className="w-[170px]"><SelectValue placeholder="Everyone" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="">Everyone</SelectItem>
            <SelectItem value="salesperson">Salespeople only</SelectItem>
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1); }}>
          <SelectTrigger className="w-[150px]"><SelectValue placeholder="Any status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="">Any status</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="inactive">Inactive</SelectItem>
          </SelectContent>
        </Select>
        <span className="ml-auto text-xs text-foreground-muted">
          {/* Stated on the page because "are they all salespeople?" is the
              question this list exists to answer. */}
          {salespeople} of {rows.length} shown can earn commission
        </span>
      </Card>

      <Card className="overflow-hidden">
        <DataTable
          columns={columns}
          data={rows}
          getRowId={(r) => r.id}
          total={data?.meta.total ?? 0}
          page={page}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
          isLoading={isLoading}
          emptyMessage={
            role === "salesperson"
              ? "Nobody here has a commission structure yet. Add one under Commissions → Structures."
              : "No people are mapped yet. Map an organization under Payroll Mapping first."
          }
        />
      </Card>
    </div>
  );
}
