"use client";

import { useRouter } from "next/navigation";
import { Plus, Landmark, Search, X } from "lucide-react";
import { useState, useEffect } from "react";
import {
  type BankAccount,
  type BankAccountType,
  BANK_ACCOUNT_TYPE_LABELS,
} from "@delta/shared";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MoneyDisplay } from "@/components/ui/money";
import { useTableQuery } from "@/lib/use-table-query";
import { useBankAccounts } from "@/features/banking/api";

const TYPE_TONE: Record<BankAccountType, NonNullable<BadgeProps["tone"]>> = {
  checking: "info",
  savings: "success",
  petty_cash: "warning",
  internal: "neutral",
};

export default function BankingPage() {
  const router = useRouter();
  const t = useTableQuery({ initialSort: { key: "name", dir: "asc" } });
  const [accountType, setAccountType] = useState("all");
  const [isActive, setIsActive] = useState("all");
  useEffect(() => t.resetPage(), [accountType, isActive]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data, isLoading } = useBankAccounts({
    ...t.baseParams,
    accountType: accountType === "all" ? undefined : accountType,
    isActive: isActive === "all" ? undefined : isActive,
  });

  const hasFilters = accountType !== "all" || isActive !== "all" || !!t.q;

  const columns: Column<BankAccount>[] = [
    {
      key: "name",
      header: "Account",
      sortable: true,
      cell: (a) => (
        <div>
          <p className="font-medium text-primary">{a.accountName}</p>
          {a.bankName && <p className="text-xs text-foreground-muted">{a.bankName}</p>}
        </div>
      ),
    },
    {
      key: "type",
      header: "Type",
      sortable: true,
      cell: (a) => (
        <Badge tone={TYPE_TONE[a.accountType] ?? "neutral"}>
          {BANK_ACCOUNT_TYPE_LABELS[a.accountType]}
        </Badge>
      ),
    },
    {
      key: "currency",
      header: "Currency",
      cell: (a) => <span className="font-mono text-sm">{a.currency}</span>,
    },
    {
      key: "balance",
      header: "Balance",
      align: "right",
      sortable: true,
      cell: (a) => (
        <MoneyDisplay
          minor={a.currentBalanceMinor}
          currency={a.currency}
          className={`font-medium ${a.currentBalanceMinor < 0 ? "text-danger" : ""}`}
        />
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (a) => (
        <Badge tone={a.isActive ? "success" : "neutral"}>
          {a.isActive ? "Active" : "Inactive"}
        </Badge>
      ),
    },
    {
      key: "lastReconciled",
      header: "Last Reconciled",
      cell: (a) => (
        <span className="text-foreground-muted text-sm">
          {a.lastReconciledAt ? a.lastReconciledAt.slice(0, 10) : "Never"}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-4 p-6">
      <PageHeader
        icon={Landmark}
        title="Banking"
        description="Manage bank accounts and reconcile transactions."
        action={
          <Button onClick={() => router.push("/banking/new")}>
            <Plus className="h-4 w-4" /> Add account
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-3">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle" />
          <Input
            value={t.q}
            onChange={(e) => t.setQ(e.target.value)}
            placeholder="Search accounts…"
            className="pl-8"
          />
        </div>

        <Select value={accountType} onValueChange={setAccountType}>
          <SelectTrigger className="w-[160px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {(Object.keys(BANK_ACCOUNT_TYPE_LABELS) as BankAccountType[]).map((k) => (
              <SelectItem key={k} value={k}>
                {BANK_ACCOUNT_TYPE_LABELS[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={isActive} onValueChange={setIsActive}>
          <SelectTrigger className="w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="true">Active</SelectItem>
            <SelectItem value="false">Inactive</SelectItem>
          </SelectContent>
        </Select>

        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setAccountType("all");
              setIsActive("all");
              t.setQ("");
            }}
          >
            <X className="h-4 w-4" /> Clear
          </Button>
        )}
      </div>

      <DataTable
        columns={columns}
        data={data?.data}
        getRowId={(a) => a.id}
        total={data?.meta.total ?? 0}
        page={t.page}
        pageSize={t.pageSize}
        sort={t.sort}
        onPageChange={t.setPage}
        onPageSizeChange={t.setPageSize}
        onSortChange={t.handleSort}
        onRowClick={(a) => router.push(`/banking/${a.id}`)}
        isLoading={isLoading}
        emptyMessage="No bank accounts found."
      />
    </div>
  );
}
