"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Search, ShoppingCart, X, AlertTriangle, Pencil, Trash2 } from "lucide-react";
import { type Bill } from "@delta/shared";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MoneyDisplay } from "@/components/ui/money";
import { ExportButton } from "@/components/ui/export-button";
import type { ExportColumn } from "@/lib/export";
import { useTableQuery } from "@/lib/use-table-query";
import { useBills, useDeleteBill } from "@/features/bills/api";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useCan } from "@/lib/use-can";

const STATUS_TONE: Record<string, NonNullable<BadgeProps["tone"]>> = {
  draft: "neutral", pending_approval: "warning", approved: "primary",
  partially_paid: "warning", paid: "success", overdue: "danger", voided: "neutral",
};

const BILLS_EXPORT_COLUMNS: ExportColumn<Bill>[] = [
  { header: "Bill #", value: (b) => b.billNumber },
  { header: "Vendor", value: (b) => b.vendorName },
  { header: "Bill Date", value: (b) => b.billDate },
  { header: "Due Date", value: (b) => b.dueDate },
  { header: "Status", value: (b) => b.status.replace(/_/g, " ") },
  { header: "Currency", value: (b) => b.currency },
  { header: "Total", value: (b) => b.totalMinor / 100 },
  { header: "Balance", value: (b) => b.balanceMinor / 100 },
];

export default function BillsPage() {
  const router = useRouter();
  const t = useTableQuery({ initialSort: { key: "dueDate", dir: "asc" } });
  const [status, setStatus] = useState("all");
  const [overdue, setOverdue] = useState(false);
  useEffect(() => t.resetPage(), [status, overdue]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data, isLoading } = useBills({
    ...t.baseParams,
    status: status === "all" ? undefined : status,
    overdue: overdue ? "true" : undefined,
  });

  const hasFilters = status !== "all" || overdue || !!t.q;

  const { can } = useCan();
  const canDelete = can("bill:delete");
  const deleteBill = useDeleteBill();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectionResetKey, setSelectionResetKey] = useState(0);
  const [confirming, setConfirming] = useState<Bill[] | null>(null);

  /**
   * What can actually go, which is not everything that can be ticked.
   *
   * The rule the API enforces, which is about money rather than status: a bill
   * with nothing paid against it can be removed. A payment is a real event, and
   * deleting the bill under it would strand it — those want voiding instead,
   * which the bill's own page offers.
   *
   * The API also refuses a bill a purchase order became, or one a vendor credit
   * refers to. Neither is visible on a list row, so those are not filtered here
   * — they come back as a refusal naming the reason, which is more use than a
   * button that is quietly missing.
   */
  const isDeletable = (b: Bill) => b.amountPaidMinor === 0;

  const selected = (data?.data ?? []).filter((b) => selectedIds.includes(b.id));
  const deletable = selected.filter(isDeletable);
  const undeletable = selected.length - deletable.length;

  async function deleteBills(bills: Bill[]) {
    const results = await Promise.allSettled(bills.map((b) => deleteBill.mutateAsync(b.id)));
    const failed = results.filter((r) => r.status === "rejected");
    const gone = results.length - failed.length;

    if (gone) toast.success(`${gone} bill${gone === 1 ? "" : "s"} deleted`);
    if (failed.length) {
      const first = failed[0] as PromiseRejectedResult;
      toast.error(
        failed.length === 1 && first.reason instanceof ApiError
          ? first.reason.message
          : `${failed.length} could not be deleted`,
      );
    }
    setConfirming(null);
    setSelectedIds([]);
    setSelectionResetKey((n) => n + 1);
  }

  const columns: Column<Bill>[] = [
    { key: "number", header: "Bill #", sortable: true, cell: (b) => <span className="font-medium text-primary">{b.billNumber}</span> },
    { key: "vendor", header: "Vendor", sortable: true, cell: (b) => b.vendorName },
    { key: "billDate", header: "Bill Date", sortable: true, cell: (b) => <span className="text-foreground-muted">{b.billDate}</span> },
    { key: "dueDate", header: "Due Date", sortable: true, cell: (b) => <span className="text-foreground-muted">{b.dueDate}</span> },
    {
      key: "status", header: "Status", sortable: true,
      cell: (b) => <Badge tone={STATUS_TONE[b.status] ?? "neutral"} className="capitalize">{b.status.replace("_", " ")}</Badge>,
    },
    { key: "total", header: "Total", align: "right", sortable: true, cell: (b) => <MoneyDisplay minor={b.totalMinor} currency={b.currency} className="font-medium" /> },
    {
      key: "balance", header: "Balance", align: "right", sortable: true,
      cell: (b) => <MoneyDisplay minor={b.balanceMinor} currency={b.currency} className={b.balanceMinor > 0 ? "font-medium text-danger" : "font-medium"} />,
    },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (b) => (
        <div className="flex items-center justify-end gap-1" onClick={(ev) => ev.stopPropagation()}>
          {b.status !== "voided" && (
            <button
              type="button"
              title="Edit"
              onClick={() => router.push(`/bills/${b.id}/edit`)}
              className="rounded p-1.5 text-foreground-muted hover:bg-surface-muted hover:text-foreground"
            >
              <Pencil className="h-4 w-4" />
            </button>
          )}
          {canDelete && isDeletable(b) && (
            <button
              type="button"
              title="Delete"
              onClick={() => setConfirming([b])}
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
      <PageHeader icon={ShoppingCart} title="Bills" description="Vendor bills and payables outstanding."
        action={
          <div className="flex items-center gap-2">
            <ExportButton
              resource="bills"
              params={{
                ...t.baseParams,
                status: status === "all" ? undefined : status,
                overdue: overdue ? "true" : undefined,
              }}
              columns={BILLS_EXPORT_COLUMNS}
              filename="bills"
              title="Bills"
              size="md"
            />
            <Button onClick={() => router.push("/bills/new")}><Plus className="h-4 w-4" /> New bill</Button>
          </div>
        }
      />
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-3">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle" />
          <Input value={t.q} onChange={(e) => t.setQ(e.target.value)} placeholder="Search bills…" className="pl-8" />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {["draft", "pending_approval", "approved", "partially_paid", "paid", "voided"].map((s) => (
              <SelectItem key={s} value={s} className="capitalize">{s.replace("_", " ")}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <button
          onClick={() => setOverdue(!overdue)}
          className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${overdue ? "border-danger bg-danger/10 text-danger" : "border-border text-foreground-muted hover:bg-surface-muted"}`}
        >
          <AlertTriangle className="h-3.5 w-3.5" /> Overdue only
        </button>
        {hasFilters && <Button variant="ghost" size="sm" onClick={() => { setStatus("all"); setOverdue(false); t.setQ(""); }}><X className="h-4 w-4" /> Clear</Button>}
      </div>
      {/* Only once something is ticked: a row of controls that is always there
          but usually does nothing is worse than none. */}
      {canDelete && selectedIds.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface-muted px-4 py-2.5">
          <span className="text-sm font-medium">{selectedIds.length} selected</span>
          {undeletable > 0 && (
            <span className="text-xs text-foreground-muted">
              {undeletable === selectedIds.length
                ? "None of these can be deleted — a bill with a payment against it has to be voided instead."
                : `${undeletable} of them cannot be deleted and will be left alone.`}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSelectedIds([]);
                setSelectionResetKey((n) => n + 1);
              }}
            >
              Clear
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={deletable.length === 0}
              onClick={() => setConfirming(deletable)}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              Delete{deletable.length > 0 ? ` ${deletable.length}` : ""}
            </Button>
          </div>
        </div>
      )}

      <DataTable columns={columns} data={data?.data} getRowId={(b) => b.id} total={data?.meta.total ?? 0}
        selectable={canDelete}
        onSelectionChange={setSelectedIds}
        selectionResetKey={selectionResetKey}
        page={t.page} pageSize={t.pageSize} sort={t.sort} onPageChange={t.setPage} onPageSizeChange={t.setPageSize}
        onSortChange={t.handleSort} onRowClick={(b) => router.push(`/bills/${b.id}`)}
        isLoading={isLoading} emptyMessage="No bills found." />

      <Dialog open={confirming !== null} onOpenChange={(o) => !o && setConfirming(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              Delete {confirming?.length ?? 0} bill{(confirming?.length ?? 0) === 1 ? "" : "s"}?
            </DialogTitle>
            <DialogDescription>
              {undeletable > 0 && (confirming?.length ?? 0) > 1
                ? `${undeletable} of the ${selectedIds.length} selected cannot be deleted and will be left alone. `
                : ""}
              The bill and everything on it goes, leaving a gap in the numbering where it was. This
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <ul className="max-h-48 space-y-1 overflow-y-auto text-sm">
            {confirming?.map((b) => (
              <li
                key={b.id}
                className="flex justify-between gap-3 border-b border-border/50 py-1 last:border-0"
              >
                <span className="font-medium">{b.billNumber}</span>
                <span className="text-foreground-muted">{b.vendorName}</span>
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirming(null)}>Cancel</Button>
            <Button
              variant="destructive"
              loading={deleteBill.isPending}
              onClick={() => confirming && deleteBills(confirming)}
            >
              Delete {confirming?.length ?? 0}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
