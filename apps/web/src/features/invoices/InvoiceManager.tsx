"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Search, X, ReceiptText, Trash2, Ban } from "lucide-react";
import {
  INVOICE_STATUSES,
  INVOICE_APPROVALS,
  PAYMENT_METHODS,
  type Invoice,
  type InvoiceStatus,
  type InvoiceApproval,
} from "@delta/shared";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { DatePicker } from "@/components/ui/date-picker";
import { MoneyDisplay } from "@/components/ui/money";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TagList } from "@/features/tags/TagBadge";
import { TagPicker } from "@/features/tags/TagPicker";
import { useUsers, EVERYONE } from "@/features/users/api";
import { useTableQuery } from "@/lib/use-table-query";
import { countFilters, useUrlListParam, useUrlParam } from "@/lib/url-state";
import { FilterToggle } from "@/components/ui/filter-toggle";
import { DateRangeQuick, useUrlDateRange } from "@/components/ui/date-range-quick";
import { InvoiceSummaryCards } from "./InvoiceSummaryCards";
import { BankAccountFilter, PaymentMethodFilter, accountsOf, methodsOf } from "@/features/banking/PaymentFilters";
import { ExportButton } from "@/components/ui/export-button";
import type { ExportColumn } from "@/lib/export";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useDeleteInvoice, useVoidInvoice, useInvoices, useInvoiceListSummary } from "./api";
import { INVOICE_STATUS_TONE } from "./status";

/** "not_required" says nothing to somebody reading a filter menu. */
const APPROVAL_LABELS: Record<InvoiceApproval, string> = {
  not_required: "No approval needed",
  pending: "Waiting for approval",
  approved: "Approved",
  returned: "Sent back",
};
import { useCan } from "@/lib/use-can";

const INVOICE_EXPORT_COLUMNS: ExportColumn<Invoice>[] = [
  { header: "Invoice #", value: (inv) => inv.invoiceNumber },
  { header: "Customer", value: (inv) => inv.customerName },
  { header: "Salesperson", value: (inv) => inv.salespersonName },
  { header: "Issue", value: (inv) => inv.issueDate },
  { header: "Due", value: (inv) => inv.dueDate },
  { header: "Status", value: (inv) => inv.status },
  { header: "Paid by", value: (inv) => methodsOf(inv.payments.map((p) => p.method)) },
  { header: "Bank", value: (inv) => accountsOf(inv.payments.map((p) => p.accountName)) },
  { header: "Currency", value: (inv) => inv.currency },
  { header: "Total", value: (inv) => inv.totalMinor / 100 },
  { header: "Balance", value: (inv) => inv.balanceMinor / 100 },
];

export function InvoiceManager() {
  const router = useRouter();
  const t = useTableQuery({ initialSort: { key: "createdAt", dir: "desc" } });
  // Every filter in the address bar (2026-10-22) — read back on opening, so the approvals queue's link here with
  // ?approval=pending still lands on the ones waiting.
  const [status, setStatus] = useUrlParam<InvoiceStatus | "all">("status", "all", { allowed: INVOICE_STATUSES });
  const [approval, setApproval] = useUrlParam<InvoiceApproval | "all">("approval", "all", { allowed: INVOICE_APPROVALS });
  const [salespersonId, setSalespersonId] = useUrlParam("salesperson", "");
  // When it was issued: Today, This week, This month, Last 30 days or Custom (2026-10-22) — beside the search.
  const issued = useUrlDateRange({ fromKey: "issueFrom", toKey: "issueTo" });
  const issueFrom = issued.from, issueTo = issued.to;
  const [dueFrom, setDueFrom] = useUrlParam("dueFrom", "");
  const [dueTo, setDueTo] = useUrlParam("dueTo", "");
  const [tagIds, setTagIds] = useUrlListParam("tags");
  // How it was paid and into which account (2026-10-22): any of its payments.
  const [paymentMethod, setPaymentMethod] = useUrlParam("paidBy", "");
  const [bankAccountId, setBankAccountId] = useUrlParam("bank", "");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [rowDeleting, setRowDeleting] = useState<Invoice | null>(null);
  const [confirmingVoid, setConfirmingVoid] = useState(false);
  /** Bumped after a delete, to untick rows that are no longer there. */
  const [selectionResetKey, setSelectionResetKey] = useState(0);
  const deleteInvoice = useDeleteInvoice();
  const voidInvoice = useVoidInvoice();

  // One set of filters for the table and its export, so the export is always what the table shows (2026-10-18).
  const listParams = {
    ...t.baseParams,
    status: status === "all" ? undefined : status,
    approval: approval === "all" ? undefined : approval,
    salespersonId: salespersonId || undefined,
    issueFrom: issueFrom || undefined,
    issueTo: issueTo || undefined,
    dueFrom: dueFrom || undefined,
    dueTo: dueTo || undefined,
    tagIds: tagIds.length ? tagIds : undefined,
    paymentMethod: paymentMethod || undefined,
    bankAccountId: bankAccountId || undefined,
  };
  const { data, isLoading, isPlaceholderData } = useInvoices(listParams);
  // The cards above the table: what these same filters match, per currency (2026-10-22).
  const summary = useInvoiceListSummary(listParams);

  // Somebody who only sees their own invoices has one salesperson to choose
  // from — themselves — and cannot read the user list to build the picker.
  const { can, ownOnly } = useCan();
  const mineOnly = ownOnly("invoice:read", "invoice:read:own");
  // Deleting is behind the broad permission, as it is on the server: somebody
  // limited to their own invoices cannot remove one.
  const canDelete = can("invoice:write");

  const selected = (data?.data ?? []).filter((inv) => selectedIds.includes(inv.id));
  /*
   * What can be removed outright: any invoice with nothing paid against it,
   * whatever its status (the user, 2026-10-16). One with payments keeps them
   * until each is deleted on the invoice, so money is never erased by this.
   * The server checks further still (a credit note, a commission, a quotation,
   * a balance or Tetra payment referring to it) and refuses with a reason,
   * which the toolbar reports rather than guessing at here.
   */
  const deletable = selected.filter((inv) => inv.amountPaidMinor === 0);
  const undeletable = selected.length - deletable.length;

  /*
   * What can be cancelled, which is nearly everything.
   *
   * The server refuses only two: an invoice already void, and a paid one —
   * money that has arrived is reversed with a credit note, not by cancelling
   * the document it was paid against. "Overdue" is not a stored status, it is
   * a sent invoice past its date, so those are cancellable like any other.
   */
  const voidable = selected.filter((inv) => inv.status !== "void" && inv.status !== "paid");
  /**
   * Neither cancellable nor deletable, so there is nothing to offer for these.
   *
   * Derived from the two sets rather than listed again: a voided invoice with
   * nothing paid against it is deletable, and naming the statuses twice is how
   * the toolbar and the buttons end up disagreeing.
   */
  const untouchable = selected.filter(
    (inv) => !voidable.includes(inv) && !deletable.includes(inv),
  );

  /**
   * Delete what can be deleted, and say plainly what happened.
   *
   * One request per invoice, because that is the endpoint there is. Failures
   * are counted rather than thrown: stopping halfway through would leave the
   * selection half gone with nothing said about which half.
   */
  /**
   * Cancel what can be cancelled, and say plainly what happened.
   *
   * One request per invoice, as deleting does, and failures are counted rather
   * than thrown — stopping halfway would leave half the selection cancelled
   * with nothing said about which half.
   */
  async function voidSelected() {
    const results = await Promise.allSettled(voidable.map((inv) => voidInvoice.mutateAsync(inv.id)));
    const failed = results.filter((r) => r.status === "rejected");
    const done = results.length - failed.length;

    if (done) toast.success(`${done} invoice${done === 1 ? "" : "s"} voided`);
    if (failed.length) {
      const first = failed[0] as PromiseRejectedResult;
      toast.error(
        failed.length === 1 && first.reason instanceof ApiError
          ? first.reason.message
          : `${failed.length} could not be voided`,
      );
    }
    setConfirmingVoid(false);
    setSelectedIds([]);
    setSelectionResetKey((n) => n + 1);
  }

  async function deleteSelected() {
    const results = await Promise.allSettled(
      deletable.map((inv) => deleteInvoice.mutateAsync(inv.id)),
    );
    const failed = results.filter((r) => r.status === "rejected");
    const gone = results.length - failed.length;

    if (gone) toast.success(`${gone} invoice${gone === 1 ? "" : "s"} deleted`);
    if (failed.length) {
      const first = failed[0] as PromiseRejectedResult;
      toast.error(
        failed.length === 1 && first.reason instanceof ApiError
          ? first.reason.message
          : `${failed.length} could not be deleted`,
      );
    }
    setConfirmingDelete(false);
    setSelectedIds([]);
    setSelectionResetKey((n) => n + 1);
  }

  const { data: users } = useUsers(
    { pageSize: EVERYONE, sort: "name", dir: "asc" },
    { enabled: !mineOnly },
  );

  // The range is on show beside the search, so the button counts the rest.
  const filterCount = countFilters(status, approval, salespersonId, dueFrom, dueTo, tagIds, paymentMethod, bankAccountId);
  const hasFilters = filterCount > 0 || issued.range !== "all";

  const clear = () => {
    setStatus("all");
    setApproval("all");
    setSalespersonId("");
    issued.setRange("all");
    setDueFrom("");
    setDueTo("");
    setTagIds([]);
    setPaymentMethod("");
    setBankAccountId("");
  };

  const columns: Column<Invoice>[] = [
    {
      key: "number",
      header: "Invoice #",
      sortable: true,
      cell: (inv) => (
        <Link href={`/invoices/${inv.id}`} className="font-medium text-primary hover:underline">
          {inv.invoiceNumber}
        </Link>
      ),
    },
    { key: "customer", header: "Customer", sortable: true, cell: (inv) => inv.customerName },
    // A column naming whose invoice it is says nothing when they are all
    // yours.
    ...(mineOnly
      ? []
      : [
          {
            key: "salesperson",
            header: "Salesperson",
            sortable: true,
            cell: (inv: Invoice) => <span className="text-foreground-muted">{inv.salespersonName}</span>,
          },
        ]),
    { key: "tags", header: "Tags", cell: (inv) => <TagList tags={inv.tags} /> },
    { key: "issue", header: "Issue", sortable: true, cell: (inv) => <span className="text-foreground-muted">{inv.issueDate}</span> },
    { key: "due", header: "Due", sortable: true, cell: (inv) => <span className="text-foreground-muted">{inv.dueDate}</span> },
    {
      key: "status",
      header: "Status",
      sortable: true,
      cell: (inv) => (
        <Badge tone={INVOICE_STATUS_TONE[inv.status]} className="capitalize">
          {inv.status}
        </Badge>
      ),
    },
    // How it was paid and where it landed (2026-10-22) — every payment's, each once; "—" while nothing is paid.
    {
      key: "paidBy",
      header: "Paid by",
      cell: (inv) => <span className="text-foreground-muted">{methodsOf(inv.payments.map((p) => p.method)) || "—"}</span>,
    },
    {
      key: "bank",
      header: "Bank",
      cell: (inv) => <span className="text-foreground-muted">{accountsOf(inv.payments.map((p) => p.accountName)) || "—"}</span>,
    },
    {
      key: "total",
      header: "Total",
      align: "right",
      sortable: true,
      cell: (inv) => <MoneyDisplay minor={inv.totalMinor} currency={inv.currency} className="font-medium" />,
    },
    {
      key: "balance",
      header: "Balance",
      align: "right",
      sortable: false,
      cell: (inv) => (
        <MoneyDisplay
          minor={inv.balanceMinor}
          currency={inv.currency}
          className={inv.balanceMinor > 0 ? "text-danger font-medium" : "text-foreground-muted"}
        />
      ),
    },
    // Delete on the row itself (the user, 2026-10-16), as on bills and expenses: once nothing is paid against it.
    ...(canDelete ? [{
      key: "actions",
      header: "",
      cell: (inv: Invoice) => (inv.amountPaidMinor === 0 ? (
        <div className="flex justify-end" onClick={(ev) => ev.stopPropagation()}>
          <button
            type="button"
            title="Delete"
            onClick={() => setRowDeleting(inv)}
            className="rounded p-1.5 text-foreground-muted hover:bg-danger/10 hover:text-danger"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      ) : null),
    }] : []),
  ];

  return (
    <div className="space-y-4 p-6">
      <PageHeader
        icon={ReceiptText}
        title="Invoices"
        description="Create, send and track invoices through to payment."
        action={
          <div className="flex items-center gap-2">
            <FilterToggle open={filtersOpen} onToggle={() => setFiltersOpen((o) => !o)} count={filterCount} />
            <ExportButton
              resource="invoices"
              params={listParams}
              columns={INVOICE_EXPORT_COLUMNS}
              filename="invoices"
              title="Invoices"
              size="md"
            />
            <Button onClick={() => router.push("/invoices/new")}>
              <Plus className="h-4 w-4" /> New invoice
            </Button>
          </div>
        }
      />

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface p-3">
        <div className="min-w-[200px] flex-1">
          <label className="mb-1 block text-xs font-medium text-foreground-muted">Search</label>
          {/* Centred on the box itself, not a fixed offset from the label (it sat high — 2026-10-22). */}
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle" />
            <Input value={t.q} onChange={(e) => t.setQ(e.target.value)} placeholder="Invoice # or customer…" className="pl-8" />
          </div>
        </div>
        <Field label="Issued"><DateRangeQuick value={issued} /></Field>

        {/* The rest only once Filters is pressed (2026-10-22); the search stays out. */}
        {filtersOpen && (<>

        <Field label="Status">
          <Select value={status} onValueChange={(v) => setStatus(v as InvoiceStatus | "all")}>
            <SelectTrigger className="w-[130px]">
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              {INVOICE_STATUSES.map((s) => (
                <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field label="Approval">
          <Select value={approval} onValueChange={(v) => setApproval(v as InvoiceApproval | "all")}>
            <SelectTrigger className="w-[150px]">
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              {INVOICE_APPROVALS.map((a) => (
                <SelectItem key={a} value={a}>{APPROVAL_LABELS[a]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        {!mineOnly && (
        <Field label="Salesperson">
          <Select value={salespersonId || "all"} onValueChange={(v) => setSalespersonId(v === "all" ? "" : v)}>
            <SelectTrigger className="w-[150px]">
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              {users?.data.map((u) => (
                <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        )}

        <Field label="Due from"><DatePicker value={dueFrom} onChange={setDueFrom} clearable placeholder="Any" className="w-[140px]" /></Field>
        <Field label="Due to"><DatePicker value={dueTo} onChange={setDueTo} clearable placeholder="Any" className="w-[140px]" /></Field>
        <Field label="Tags"><div className="w-[180px]"><TagPicker value={tagIds} onChange={setTagIds} placeholder="Any tags…" /></div></Field>
        <Field label="Paid by"><PaymentMethodFilter methods={PAYMENT_METHODS} value={paymentMethod} onChange={setPaymentMethod} /></Field>
        <Field label="Bank account"><BankAccountFilter value={bankAccountId} onChange={setBankAccountId} /></Field>

        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={clear}>
            <X className="h-4 w-4" /> Clear
          </Button>
        )}
        </>)}
      </div>

      {/* An API from before the cards answers 404: the page then simply has none. */}
      {!summary.error && <InvoiceSummaryCards summary={summary.data} loading={summary.isLoading} refreshing={summary.isPlaceholderData} />}

      {/* Only once something is ticked. A row of controls that is always there
          but usually does nothing is worse than none. */}
      {canDelete && selectedIds.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface-muted px-4 py-2.5">
          <span className="text-sm font-medium">
            {selectedIds.length} selected
          </span>
          {/* What each button will act on, rather than leaving somebody to
              work out why a count is lower than their selection. Only drafts
              can be deleted; anything not already void or paid can be
              cancelled. */}
          {untouchable.length > 0 && (
            <span className="text-xs text-foreground-muted">
              {untouchable.length === selectedIds.length
                ? "These are already void or paid, so there is nothing to do here."
                : `${untouchable.length} already void or paid — ${untouchable.length === 1 ? "that one stays" : "those stay"} as ${untouchable.length === 1 ? "it is" : "they are"}.`}
            </span>
          )}
          {untouchable.length === 0 && undeletable > 0 && (
            <span className="text-xs text-foreground-muted">
              {undeletable === selectedIds.length
                ? "None of these can be deleted — they have payments recorded. Delete the payments on the invoice first, or void them."
                : `${undeletable} of them have payments recorded, so they can be voided but not deleted.`}
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
              variant="secondary"
              size="sm"
              disabled={voidable.length === 0}
              onClick={() => setConfirmingVoid(true)}
            >
              <Ban className="mr-1.5 h-3.5 w-3.5" />
              Void{voidable.length > 0 ? ` ${voidable.length}` : ""}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={deletable.length === 0}
              onClick={() => setConfirmingDelete(true)}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              Delete{deletable.length > 0 ? ` ${deletable.length}` : ""}
            </Button>
          </div>
        </div>
      )}

      <DataTable
        columns={columns}
        data={data?.data}
        getRowId={(inv) => inv.id}
        total={data?.meta.total ?? 0}
        page={t.page}
        pageSize={t.pageSize}
        sort={t.sort}
        onPageChange={t.setPage}
        onPageSizeChange={t.setPageSize}
        onSortChange={t.handleSort}
        selectable
        onSelectionChange={setSelectedIds}
        selectionResetKey={selectionResetKey}
        isLoading={isLoading} isFetching={isPlaceholderData}
        emptyMessage="No invoices match your filters."
      />

      <Dialog open={confirmingVoid} onOpenChange={setConfirmingVoid}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              Void {voidable.length} invoice{voidable.length === 1 ? "" : "s"}?
            </DialogTitle>
            <DialogDescription>
              {untouchable.length > 0
                ? `${untouchable.length} of the ${selectedIds.length} selected ${untouchable.length === 1 ? "is" : "are"} already void or paid and will be left alone. `
                : ""}
              A voided invoice keeps its number and stays on the record as cancelled, and any stock
              it took is put back. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <ul className="max-h-48 space-y-1 overflow-y-auto text-sm">
            {voidable.map((inv) => (
              <li key={inv.id} className="flex justify-between gap-3 border-b border-border/50 py-1 last:border-0">
                <span className="font-medium">{inv.invoiceNumber}</span>
                <span className="text-foreground-muted">{inv.customerName}</span>
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirmingVoid(false)}>Cancel</Button>
            <Button variant="destructive" loading={voidInvoice.isPending} onClick={voidSelected}>
              Void {voidable.length}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!rowDeleting} onOpenChange={(o) => { if (!o) setRowDeleting(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {rowDeleting?.invoiceNumber}?</DialogTitle>
            <DialogDescription>
              {rowDeleting?.customerName} — removed for good, leaving a gap in the numbering; void it instead to keep it on the record as
              cancelled. An enrolment from a sales CRM keeps the LMS access and CS Portal account it already gave — remove those by
              hand. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setRowDeleting(null)}>Cancel</Button>
            <Button
              variant="destructive"
              loading={deleteInvoice.isPending}
              onClick={async () => {
                if (!rowDeleting) return;
                try {
                  await deleteInvoice.mutateAsync(rowDeleting.id);
                  toast.success(`${rowDeleting.invoiceNumber} deleted`);
                  setRowDeleting(null);
                } catch (err) {
                  toast.error(err instanceof ApiError ? err.message : "Could not delete this invoice");
                }
              }}
            >
              Delete invoice
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              Delete {deletable.length} invoice{deletable.length === 1 ? "" : "s"}?
            </DialogTitle>
            <DialogDescription>
              {undeletable > 0
                ? `${undeletable} of the ${selectedIds.length} selected cannot be deleted and will be left alone. `
                : ""}
              Each leaves a gap in the numbering where it was. An enrolment from a sales CRM keeps the LMS access and
              CS Portal account it already gave — remove those by hand. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <ul className="max-h-48 space-y-1 overflow-y-auto text-sm">
            {deletable.map((inv) => (
              <li key={inv.id} className="flex justify-between gap-3 border-b border-border/50 py-1 last:border-0">
                <span className="font-medium">{inv.invoiceNumber}</span>
                <span className="text-foreground-muted">{inv.customerName}</span>
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirmingDelete(false)}>Cancel</Button>
            <Button variant="destructive" loading={deleteInvoice.isPending} onClick={deleteSelected}>
              Delete {deletable.length}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-foreground-muted">{label}</label>
      {children}
    </div>
  );
}
