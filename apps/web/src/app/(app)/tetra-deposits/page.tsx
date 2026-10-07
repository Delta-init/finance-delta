"use client";

import { useEffect, useState } from "react";
import { Coins, Search, X } from "lucide-react";
import type { TetraDeposit, TetraDepositListStatus } from "@delta/shared";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataTable, type Column } from "@/components/ui/data-table";
import { MoneyDisplay } from "@/components/ui/money";
import { ExportButton } from "@/components/ui/export-button";
import type { ExportColumn } from "@/lib/export";
import { useTableQuery } from "@/lib/use-table-query";
import { useCan } from "@/lib/use-can";
import { cn } from "@/lib/utils";
import { useTetraDepositList } from "@/features/tetra-deposits/api";
import { TetraDepositDetailsDialog } from "@/features/tetra-deposits/details-dialog";
import { TetraTypeTag, paidBy, receiptsOf } from "@/features/tetra-deposits/review-dialog";
import { STATUS_LABELS, TetraDepositStatusBadge, deliveryText, formatWhen } from "@/features/tetra-deposits/status";

/**
 * Every deposit request Tetra Commission has sent for approval — waiting,
 * approved, rejected — for the accounts team to look back through, search and
 * export. Deciding is done on the Approvals page; this is the record.
 *
 * Behind the permission that decides them, so the accountants, administrators
 * and super admins see it, and nobody else.
 */

const TABS: { status: TetraDepositListStatus; label: string }[] = [
  { status: "all", label: "All" },
  { status: "pending", label: "Pending" },
  { status: "approved", label: "Approved" },
  { status: "rejected", label: "Rejected" },
  { status: "closed", label: "Closed" },
];

const LEVELS: Record<string, string> = { LEVEL_1: "Level 1", LEVEL_2: "Level 2" };

const approvedAmount = (d: TetraDeposit) =>
  d.status === "approved" || (d.status === "closed" && d.decision?.transactionId) ? d.decision?.approvedAmountMinor : undefined;
/** How it was paid: the method an accountant set on approving it, else every payment's ("CARD PAYMENT + Cash deposit"). */
const methodOf = (d: TetraDeposit) =>
  d.decision?.paymentMethod && d.decision.paymentMethod !== d.paymentMethod ? d.decision.paymentMethod : paidBy(d);

const EXPORT_COLUMNS: ExportColumn<TetraDeposit>[] = [
  { header: "Requested", value: (d) => formatWhen(d.requestedAt) },
  { header: "Type", value: (d) => (d.type === "BONUS" ? "Bonus" : d.type === "COURSE_UPGRADE" ? "Course payment" : "Deposit") },
  { header: "Student", value: (d) => d.student.name },
  { header: "Student code", value: (d) => d.student.code },
  { header: "Student email", value: (d) => d.student.email },
  { header: "Level at request", value: (d) => LEVELS[d.student.level] ?? d.student.level },
  { header: "Team", value: (d) => d.team },
  { header: "Raised by", value: (d) => d.requestedBy },
  { header: "Mentor", value: (d) => d.initiatingMentor },
  { header: "Primary mentor", value: (d) => d.primaryMentor },
  { header: "Payment method", value: (d) => methodOf(d) },
  { header: "MT5 login", value: (d) => d.decision?.mt5Login || d.mt5Login },
  { header: "Currency", value: (d) => d.currency },
  { header: "Requested amount", value: (d) => d.amountMinor / 100 },
  { header: "Approved amount", value: (d) => { const a = approvedAmount(d); return a === undefined ? "" : a / 100; } },
  { header: "Transaction ID", value: (d) => d.decision?.transactionId ?? "" },
  { header: "Status", value: (d) => STATUS_LABELS[d.status] ?? d.status },
  { header: "Decided by", value: (d) => d.decision?.decidedByName ?? "" },
  { header: "Decided", value: (d) => formatWhen(d.decision?.decidedAt) },
  { header: "Reason / note", value: (d) => d.decision?.reason || d.decision?.note || "" },
  { header: "Tetra Commission", value: (d) => deliveryText(d) },
  { header: "Proof of payment", value: (d) => receiptsOf(d).join(" ") },
  { header: "Tetra Commission id", value: (d) => d.externalId },
];

/** The picked days as instants in the viewer's own timezone: the start of the first, and of the day after the last. */
const startOf = (day: string) => new Date(`${day}T00:00:00`).toISOString();
const dayAfter = (day: string) => {
  const next = new Date(`${day}T00:00:00`);
  next.setDate(next.getDate() + 1);
  return next.toISOString();
};

export default function TetraDepositsPage() {
  const { can, ready } = useCan();
  const allowed = can("tetra_deposit:approve");
  const t = useTableQuery({ initialSort: { key: "requestedAt", dir: "desc" }, initialPageSize: 25 });
  const [status, setStatus] = useState<TetraDepositListStatus>("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => t.resetPage(), [status, dateFrom, dateTo]); // eslint-disable-line react-hooks/exhaustive-deps

  const filters = {
    status,
    from: dateFrom ? startOf(dateFrom) : undefined,
    to: dateTo ? dayAfter(dateTo) : undefined,
  };
  const { data, isLoading } = useTetraDepositList({ ...t.baseParams, ...filters }, allowed);
  const counts = data?.meta.counts;
  const hasFilters = !!(dateFrom || dateTo || t.q);

  if (!ready) return null;
  if (!allowed) {
    return <div className="p-6 text-sm text-foreground-muted">Tetra Commission deposits are for the accounts team.</div>;
  }

  const columns: Column<TetraDeposit>[] = [
    {
      key: "requestedAt",
      header: "Requested",
      sortable: true,
      cell: (d) => <span className="whitespace-nowrap text-sm">{formatWhen(d.requestedAt)}</span>,
    },
    {
      key: "student",
      header: "Student",
      sortable: true,
      cell: (d) => (
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 truncate font-medium">{d.student.name}<TetraTypeTag deposit={d} /></p>
          <p className="truncate text-xs text-foreground-muted">{[d.student.code, d.team, d.coursePayment?.product].filter(Boolean).join(" · ")}</p>
        </div>
      ),
    },
    {
      key: "payment",
      header: "Payment",
      cell: (d) => (
        <div className="min-w-0 text-sm">
          <p className="truncate">{methodOf(d) || "—"}</p>
          {(d.decision?.mt5Login || d.mt5Login) && <p className="truncate text-xs text-foreground-muted">MT5 {d.decision?.mt5Login || d.mt5Login}</p>}
        </div>
      ),
    },
    {
      key: "raisedBy",
      header: "Raised by",
      cell: (d) => <span className="text-sm">{d.requestedBy || d.initiatingMentor || "—"}</span>,
    },
    {
      key: "amount",
      header: "Amount",
      sortable: true,
      align: "right",
      cell: (d) => <MoneyDisplay minor={d.amountMinor} currency={d.currency} />,
    },
    {
      key: "approvedAmount",
      header: "Approved",
      align: "right",
      cell: (d) => {
        const a = approvedAmount(d);
        return a === undefined ? <span className="text-foreground-muted">—</span> : <MoneyDisplay minor={a} currency={d.currency} className="font-medium" />;
      },
    },
    {
      key: "transactionId",
      header: "Transaction ID",
      cell: (d) => <span className="font-mono text-xs">{d.decision?.transactionId || "—"}</span>,
    },
    {
      key: "status",
      header: "Status",
      sortable: true,
      cell: (d) => {
        const note = d.status === "pending" ? "" : deliveryText(d);
        return (
          <div className="min-w-0">
            <TetraDepositStatusBadge status={d.status} />
            {note && note !== "In Tetra Commission" && (
              <p className={cn("mt-1 max-w-[220px] truncate text-xs", d.delivery?.state === "failed" ? "text-danger" : "text-foreground-muted")} title={note}>
                {note}
              </p>
            )}
          </div>
        );
      },
    },
    {
      key: "decidedAt",
      header: "Decided",
      sortable: true,
      cell: (d) =>
        d.decision ? (
          <div className="min-w-0 text-sm">
            <p className="truncate">{d.decision.decidedByName}</p>
            <p className="whitespace-nowrap text-xs text-foreground-muted">{formatWhen(d.decision.decidedAt)}</p>
          </div>
        ) : (
          <span className="text-foreground-muted">—</span>
        ),
    },
  ];

  // Closed ones are rare — gone from Tetra Commission, or decided there — so
  // their tab appears only when there are some to show.
  const tabs = TABS.filter((tab) => tab.status !== "closed" || (counts?.closed ?? 0) > 0 || status === "closed");

  return (
    <div className="space-y-4 p-4 md:p-6">
      <PageHeader
        icon={Coins}
        title="Tetra Commission deposits"
        description="Every deposit and bonus request Tetra Commission sent for approval — pending, approved and rejected. They are decided on the Approvals page."
        action={
          <ExportButton
            resource="tetra-deposits/list"
            params={{ ...t.baseParams, ...filters }}
            columns={EXPORT_COLUMNS}
            filename="tetra-commission-deposits"
            title="Tetra Commission deposits"
            formats={["csv", "excel", "pdf"]}
            size="md"
          />
        }
      />

      <div role="tablist" aria-label="Status" className="flex w-full flex-wrap gap-1 rounded-lg border border-border bg-surface p-1 sm:w-fit">
        {tabs.map((tab) => {
          const active = status === tab.status;
          const n = counts?.[tab.status];
          return (
            <button
              key={tab.status}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setStatus(tab.status)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                active ? "bg-primary text-primary-foreground shadow-xs" : "text-foreground-muted hover:bg-surface-muted hover:text-foreground",
              )}
            >
              {tab.label}
              {n !== undefined && (
                <span className={cn("rounded-full px-1.5 text-xs", active ? "bg-white/20" : "bg-surface-muted")}>{n}</span>
              )}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-3">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle" />
          <Input
            value={t.q}
            onChange={(e) => t.setQ(e.target.value)}
            placeholder="Search student, code, transaction ID, MT5, mentor…"
            className="pl-8"
          />
        </div>
        <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="w-[150px]" aria-label="Requested from" />
        <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="w-[150px]" aria-label="Requested to" />
        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setDateFrom("");
              setDateTo("");
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
        getRowId={(d) => d.id}
        total={data?.meta.total ?? 0}
        page={t.page}
        pageSize={t.pageSize}
        sort={t.sort}
        onPageChange={t.setPage}
        onPageSizeChange={t.setPageSize}
        onSortChange={t.handleSort}
        onRowClick={(d) => setOpenId(d.id)}
        isLoading={isLoading}
        emptyMessage={hasFilters ? "No deposits match these filters." : "No deposits here yet."}
      />

      <TetraDepositDetailsDialog id={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}
