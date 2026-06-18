"use client";

import { useState } from "react";
import { FileText, CheckCircle2 } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MoneyDisplay } from "@/components/ui/money";
import { DatePicker } from "@/components/ui/date-picker";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataTable, type Column } from "@/components/ui/data-table";
import { useCommissionRecords, useMarkPaid, useCancelRecord } from "@/features/commissions/api";
import type { CommissionRecord } from "@delta/shared";

function today() { return new Date().toISOString().slice(0, 10); }
function yearStart() { return `${new Date().getFullYear()}-01-01`; }

const STATUS_TONE: Record<string, "success" | "warning" | "neutral" | "danger"> = {
  earned: "warning",
  paid: "success",
  cancelled: "neutral",
};

const BASIS_LABELS: Record<string, string> = {
  invoice_raised: "Invoice raised",
  payment_received: "Payment received",
};

export default function RecordsPage() {
  const [from, setFrom] = useState(yearStart());
  const [to, setTo] = useState(today());
  const [status, setStatus] = useState("earned");
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const { data, isLoading } = useCommissionRecords({ from, to, status: status || undefined, page, pageSize: 20 });
  const { mutate: markPaid, isPending: paying } = useMarkPaid();
  const { mutate: cancel } = useCancelRecord();

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleMarkPaid() {
    markPaid(
      { recordIds: Array.from(selectedIds), notes: "" },
      { onSuccess: () => setSelectedIds(new Set()) },
    );
  }

  const columns: Column<CommissionRecord>[] = [
    {
      key: "id",
      header: "",
      cell: (r) =>
        r.status === "earned" ? (
          <input
            type="checkbox"
            checked={selectedIds.has(r.id)}
            onChange={() => toggleSelect(r.id)}
            className="h-4 w-4 rounded border-border"
          />
        ) : null,
    },
    {
      key: "salespersonName",
      header: "Salesperson",
      sortable: true,
      cell: (r) => <span className="font-medium text-foreground">{r.salespersonName}</span>,
    },
    {
      key: "invoiceNumber",
      header: "Invoice",
      sortable: true,
      cell: (r) => <span className="font-mono text-sm">{r.invoiceNumber}</span>,
    },
    {
      key: "basis",
      header: "Trigger",
      cell: (r) => <span className="text-sm text-foreground-muted">{BASIS_LABELS[r.basis]}</span>,
    },
    {
      key: "invoiceTotalMinor",
      header: "Invoice Total",
      align: "right",
      sortable: true,
      cell: (r) => <MoneyDisplay minor={r.invoiceTotalMinor} />,
    },
    {
      key: "commissionMinor",
      header: "Commission",
      align: "right",
      sortable: true,
      cell: (r) => <MoneyDisplay minor={r.commissionMinor} className="font-semibold" />,
    },
    {
      key: "status",
      header: "Status",
      cell: (r) => (
        <Badge tone={STATUS_TONE[r.status]} className="capitalize">{r.status}</Badge>
      ),
    },
    {
      key: "calculatedAt",
      header: "Date",
      sortable: true,
      cell: (r) => (
        <span className="text-sm text-foreground-muted">
          {new Date(r.calculatedAt).toLocaleDateString()}
        </span>
      ),
    },
    {
      key: "id",
      header: "",
      align: "right",
      cell: (r) =>
        r.status === "earned" ? (
          <button
            onClick={() => cancel(r.id)}
            className="text-xs text-foreground-muted hover:text-danger"
          >
            Cancel
          </button>
        ) : null,
    },
  ];

  const earnedCount = data?.data.filter((r) => r.status === "earned").length ?? 0;

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        icon={FileText}
        title="Commission Records"
        description="All auto-calculated commission records. Select earned records to mark as paid."
        action={
          selectedIds.size > 0 ? (
            <Button onClick={handleMarkPaid} disabled={paying}>
              <CheckCircle2 className="h-4 w-4" />
              {paying ? "Processing…" : `Mark ${selectedIds.size} as Paid`}
            </Button>
          ) : undefined
        }
      />

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-3">
        <span className="text-sm text-foreground-muted">Period:</span>
        <DatePicker value={from} onChange={setFrom} placeholder="From" />
        <span className="text-foreground-subtle">→</span>
        <DatePicker value={to} onChange={setTo} placeholder="To" />
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-[140px]"><SelectValue placeholder="All statuses" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="">All</SelectItem>
            <SelectItem value="earned">Earned</SelectItem>
            <SelectItem value="paid">Paid</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Selection bar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 px-4 py-2.5 text-sm">
          <span className="font-medium text-primary">{selectedIds.size} selected</span>
          <button onClick={() => setSelectedIds(new Set())} className="text-foreground-muted hover:text-foreground ml-auto">
            Clear
          </button>
        </div>
      )}

      <DataTable
        columns={columns}
        data={data?.data ?? []}
        getRowId={(r) => r.id}
        total={data?.meta.total ?? 0}
        page={page}
        pageSize={20}
        onPageChange={setPage}
        onPageSizeChange={() => {}}
        isLoading={isLoading}
        emptyMessage="No commission records found for the selected filters."
      />
    </div>
  );
}
