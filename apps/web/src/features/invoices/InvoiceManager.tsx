"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Search, X, ReceiptText, Trash2 } from "lucide-react";
import {
  INVOICE_STATUSES,
  INVOICE_APPROVALS,
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
import { useUsers } from "@/features/users/api";
import { useTableQuery } from "@/lib/use-table-query";
import { ExportButton } from "@/components/ui/export-button";
import type { ExportColumn } from "@/lib/export";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useDeleteInvoice, useInvoices } from "./api";
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
  { header: "Currency", value: (inv) => inv.currency },
  { header: "Total", value: (inv) => inv.totalMinor / 100 },
  { header: "Balance", value: (inv) => inv.balanceMinor / 100 },
];

export function InvoiceManager() {
  const router = useRouter();
  const t = useTableQuery({ initialSort: { key: "createdAt", dir: "desc" } });
  const [status, setStatus] = useState<InvoiceStatus | "all">("all");
  /*
   * Seeded from the URL, because the approvals queue links here with
   * ?approval=pending. Landing on an unfiltered list after clicking "see all
   * the ones waiting" would answer a different question from the one asked.
   */
  const search = useSearchParams();
  const [approval, setApproval] = useState<InvoiceApproval | "all">(() => {
    const q = search.get("approval");
    return (INVOICE_APPROVALS as readonly string[]).includes(q ?? "")
      ? (q as InvoiceApproval)
      : "all";
  });
  const [salespersonId, setSalespersonId] = useState("");
  const [issueFrom, setIssueFrom] = useState("");
  const [issueTo, setIssueTo] = useState("");
  const [dueFrom, setDueFrom] = useState("");
  const [dueTo, setDueTo] = useState("");
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  /** Bumped after a delete, to untick rows that are no longer there. */
  const [selectionResetKey, setSelectionResetKey] = useState(0);
  const deleteInvoice = useDeleteInvoice();

  useEffect(() => t.resetPage(), [status, approval, salespersonId, issueFrom, issueTo, dueFrom, dueTo, tagIds]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data, isLoading } = useInvoices({
    ...t.baseParams,
    status: status === "all" ? undefined : status,
    approval: approval === "all" ? undefined : approval,
    salespersonId: salespersonId || undefined,
    issueFrom: issueFrom || undefined,
    issueTo: issueTo || undefined,
    dueFrom: dueFrom || undefined,
    dueTo: dueTo || undefined,
    tagIds: tagIds.length ? tagIds : undefined,
  });

  // Somebody who only sees their own invoices has one salesperson to choose
  // from — themselves — and cannot read the user list to build the picker.
  const { can, ownOnly } = useCan();
  const mineOnly = ownOnly("invoice:read", "invoice:read:own");
  // Deleting is behind the broad permission, as it is on the server: somebody
  // limited to their own invoices cannot remove one.
  const canDelete = can("invoice:write");

  const selected = (data?.data ?? []).filter((inv) => selectedIds.includes(inv.id));
  // Only a draft can be deleted — the server refuses anything else, because an
  // invoice that has been sent or paid is a record of something that happened.
  const deletable = selected.filter((inv) => inv.status === "draft");
  const undeletable = selected.length - deletable.length;

  /**
   * Delete what can be deleted, and say plainly what happened.
   *
   * One request per invoice, because that is the endpoint there is. Failures
   * are counted rather than thrown: stopping halfway through would leave the
   * selection half gone with nothing said about which half.
   */
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
    { pageSize: 100, sort: "name", dir: "asc" },
    { enabled: !mineOnly },
  );

  const hasFilters =
    status !== "all" || approval !== "all" || salespersonId || issueFrom || issueTo || dueFrom || dueTo || tagIds.length > 0;

  const clear = () => {
    setStatus("all");
    setApproval("all");
    setSalespersonId("");
    setIssueFrom("");
    setIssueTo("");
    setDueFrom("");
    setDueTo("");
    setTagIds([]);
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
  ];

  return (
    <div className="space-y-4 p-6">
      <PageHeader
        icon={ReceiptText}
        title="Invoices"
        description="Create, send and track invoices through to payment."
        action={
          <div className="flex items-center gap-2">
            <ExportButton
              resource="invoices"
              params={{
                ...t.baseParams,
                status: status === "all" ? undefined : status,
                salespersonId: salespersonId || undefined,
                issueFrom: issueFrom || undefined,
                issueTo: issueTo || undefined,
                dueFrom: dueFrom || undefined,
                dueTo: dueTo || undefined,
                tagIds: tagIds.length ? tagIds : undefined,
              }}
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
        <div className="relative min-w-[200px] flex-1">
          <label className="mb-1 block text-xs font-medium text-foreground-muted">Search</label>
          <Search className="pointer-events-none absolute left-2.5 top-[31px] h-4 w-4 -translate-y-1/2 text-foreground-subtle" />
          <Input value={t.q} onChange={(e) => t.setQ(e.target.value)} placeholder="Invoice # or customer…" className="pl-8" />
        </div>

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

        <Field label="Issue from"><DatePicker value={issueFrom} onChange={setIssueFrom} clearable placeholder="Any" className="w-[140px]" /></Field>
        <Field label="Issue to"><DatePicker value={issueTo} onChange={setIssueTo} clearable placeholder="Any" className="w-[140px]" /></Field>
        <Field label="Due from"><DatePicker value={dueFrom} onChange={setDueFrom} clearable placeholder="Any" className="w-[140px]" /></Field>
        <Field label="Due to"><DatePicker value={dueTo} onChange={setDueTo} clearable placeholder="Any" className="w-[140px]" /></Field>
        <Field label="Tags"><div className="w-[180px]"><TagPicker value={tagIds} onChange={setTagIds} placeholder="Any tags…" /></div></Field>

        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={clear}>
            <X className="h-4 w-4" /> Clear
          </Button>
        )}
      </div>

      {/* Only once something is ticked. A row of controls that is always there
          but usually does nothing is worse than none. */}
      {canDelete && selectedIds.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface-muted px-4 py-2.5">
          <span className="text-sm font-medium">
            {selectedIds.length} selected
          </span>
          {undeletable > 0 && (
            <span className="text-xs text-foreground-muted">
              {undeletable === selectedIds.length
                ? "None of these are drafts, so none can be deleted."
                : `${undeletable} of them ${undeletable === 1 ? "is not a draft" : "are not drafts"} and will be left alone.`}
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
        isLoading={isLoading}
        emptyMessage="No invoices match your filters."
      />

      <Dialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              Delete {deletable.length} invoice{deletable.length === 1 ? "" : "s"}?
            </DialogTitle>
            <DialogDescription>
              {undeletable > 0
                ? `${undeletable} of the ${selectedIds.length} selected ${undeletable === 1 ? "is not a draft and will be left" : "are not drafts and will be left"} alone. `
                : ""}
              This cannot be undone.
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
