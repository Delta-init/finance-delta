"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Search, X, ReceiptText } from "lucide-react";
import { INVOICE_STATUSES, type Invoice, type InvoiceStatus } from "@delta/shared";
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
import { useInvoices } from "./api";
import { INVOICE_STATUS_TONE } from "./status";

export function InvoiceManager() {
  const router = useRouter();
  const t = useTableQuery({ initialSort: { key: "createdAt", dir: "desc" } });
  const [status, setStatus] = useState<InvoiceStatus | "all">("all");
  const [salespersonId, setSalespersonId] = useState("");
  const [issueFrom, setIssueFrom] = useState("");
  const [issueTo, setIssueTo] = useState("");
  const [dueFrom, setDueFrom] = useState("");
  const [dueTo, setDueTo] = useState("");
  const [tagIds, setTagIds] = useState<string[]>([]);

  useEffect(() => t.resetPage(), [status, salespersonId, issueFrom, issueTo, dueFrom, dueTo, tagIds]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data, isLoading } = useInvoices({
    ...t.baseParams,
    status: status === "all" ? undefined : status,
    salespersonId: salespersonId || undefined,
    issueFrom: issueFrom || undefined,
    issueTo: issueTo || undefined,
    dueFrom: dueFrom || undefined,
    dueTo: dueTo || undefined,
    tagIds: tagIds.length ? tagIds : undefined,
  });

  const { data: users } = useUsers({ pageSize: 100, sort: "name", dir: "asc" });

  const hasFilters =
    status !== "all" || salespersonId || issueFrom || issueTo || dueFrom || dueTo || tagIds.length > 0;

  const clear = () => {
    setStatus("all");
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
    { key: "salesperson", header: "Salesperson", sortable: true, cell: (inv) => <span className="text-foreground-muted">{inv.salespersonName}</span> },
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
          <Button onClick={() => router.push("/invoices/new")}>
            <Plus className="h-4 w-4" /> New invoice
          </Button>
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
        isLoading={isLoading}
        emptyMessage="No invoices match your filters."
      />
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
