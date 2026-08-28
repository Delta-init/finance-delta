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
 * Who payroll knows about, and whether each of them can earn on a sale.
 *
 * Everybody mapped from HRMS is a salesperson: the sync gives each of them a
 * finance login, because an invoice's salesperson and a commission structure
 * both reference a User, and without one they could not be picked at all.
 *
 * What varies is whether a rate has been set. Somebody with no commission
 * structure can still be named on an invoice; they simply earn nothing from it,
 * which is why the filter here finds people with no rate rather than people who
 * are not salespeople.
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
  const withRate = rows.filter((r) => r.hasCommissionStructure).length;

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
      header: "Commission rate",
      cell: (r) =>
        !r.isSalesperson ? (
          // No login means they cannot be picked on an invoice at all — which
          // after a sync only happens when HRMS has no email for them.
          <span className="inline-flex items-center gap-1.5 text-xs text-warning">
            <AlertTriangle className="h-3.5 w-3.5" />No login — needs an email in HRMS
          </span>
        ) : r.hasCommissionStructure ? (
          <Badge tone="primary">
            <TrendingUp className="mr-1 inline h-3 w-3" />Rate set
          </Badge>
        ) : (
          <span className="text-foreground-muted">No rate yet</span>
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
        description="Everyone mapped from HRMS. All of them can be picked as the salesperson on an invoice; those with a commission rate earn on it."
      />

      <Card className="flex flex-wrap items-center gap-2 p-3">
        <Input
          placeholder="Search name, code or email"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          className="w-full sm:w-64"
        />
        <Select value={role} onValueChange={(v) => { setRole(v); setPage(1); }}>
          <SelectTrigger className="w-[190px]"><SelectValue placeholder="Everyone" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="">Everyone</SelectItem>
            <SelectItem value="no_commission_rate">No commission rate yet</SelectItem>
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
          {/* Everyone mapped is a salesperson; the open question is who still
              has no rate, which is what stops them earning anything. */}
          {withRate} of {rows.length} shown have a commission rate
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
