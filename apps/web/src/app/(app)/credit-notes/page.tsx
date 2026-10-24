"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FileX, Search, X } from "lucide-react";
import { formatMoney, type CreditNote } from "@delta/shared";
import { useCreditNotes } from "@/features/credit-notes/api";
import { PageHeader } from "@/components/page-header";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ExportButton } from "@/components/ui/export-button";
import { useTableQuery } from "@/lib/use-table-query";
import type { ExportColumn } from "@/lib/export";

const STATUS_TONE: Record<string, BadgeProps["tone"]> = {
  draft: "neutral",
  issued: "primary",
  applied: "success",
  voided: "danger",
};

const CREDIT_NOTES_EXPORT_COLUMNS: ExportColumn<CreditNote>[] = [
  { header: "Number", value: (cn) => cn.creditNoteNumber },
  { header: "Customer", value: (cn) => cn.customerName },
  { header: "Invoice", value: (cn) => cn.invoiceNumber },
  { header: "Status", value: (cn) => cn.status },
  { header: "Created", value: (cn) => cn.createdAt.slice(0, 10) },
  { header: "Currency", value: (cn) => cn.currency },
  { header: "Total", value: (cn) => cn.totalMinor / 100 },
  { header: "Remaining", value: (cn) => (cn.totalMinor - cn.amountAppliedMinor) / 100 },
];

/**
 * Credit notes, a page at a time, searched and filtered by status (2026-10-18). It used to list the newest 200 with no
 * paging, and its export stopped there too; the export now takes the table's search and status, every page.
 */
export default function CreditNotesPage() {
  const router = useRouter();
  const t = useTableQuery({ initialSort: { key: "createdAt", dir: "desc" } });
  const [status, setStatus] = useState("all");
  useEffect(() => t.resetPage(), [status]); // eslint-disable-line react-hooks/exhaustive-deps

  const listParams = { ...t.baseParams, status: status === "all" ? undefined : status };
  const { data, isLoading, isPlaceholderData } = useCreditNotes(listParams);
  const hasFilters = status !== "all" || !!t.q;

  const columns: Column<CreditNote>[] = [
    {
      key: "number", header: "Number", sortable: true,
      cell: (cn) => <span className="font-medium text-primary">{cn.creditNoteNumber}</span>,
    },
    { key: "customer", header: "Customer", sortable: true, cell: (cn) => cn.customerName },
    {
      key: "invoice", header: "Invoice", sortable: true,
      cell: (cn) => (
        <Link href={`/invoices/${cn.invoiceId}`} onClick={(e) => e.stopPropagation()} className="text-foreground-muted hover:text-foreground hover:underline">
          {cn.invoiceNumber}
        </Link>
      ),
    },
    {
      key: "status", header: "Status", sortable: true,
      cell: (cn) => <Badge tone={STATUS_TONE[cn.status] ?? "neutral"} className="capitalize">{cn.status}</Badge>,
    },
    { key: "createdAt", header: "Created", sortable: true, cell: (cn) => <span className="text-foreground-muted">{cn.createdAt.slice(0, 10)}</span> },
    { key: "total", header: "Total", align: "right", sortable: true, cell: (cn) => <span className="font-numeric">{formatMoney(cn.totalMinor, cn.currency)}</span> },
    {
      key: "remaining", header: "Remaining", align: "right",
      cell: (cn) => <span className="font-numeric">{formatMoney(cn.totalMinor - cn.amountAppliedMinor, cn.currency)}</span>,
    },
  ];

  return (
    <div className="space-y-4 p-4 md:p-6">
      <PageHeader
        icon={FileX}
        title="Credit Notes"
        description="Issue credits against invoices"
        action={
          <ExportButton
            resource="credit-notes"
            params={listParams}
            columns={CREDIT_NOTES_EXPORT_COLUMNS}
            filename="credit-notes"
            title="Credit Notes"
            size="md"
          />
        }
      />
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-3">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle" />
          <Input value={t.q} onChange={(e) => t.setQ(e.target.value)} placeholder="Search number, customer, invoice…" className="pl-8" />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {["draft", "issued", "applied", "voided"].map((s) => (
              <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {hasFilters && <Button variant="ghost" size="sm" onClick={() => { setStatus("all"); t.setQ(""); }}><X className="h-4 w-4" /> Clear</Button>}
      </div>
      <DataTable
        columns={columns}
        data={data?.data}
        getRowId={(cn) => cn.id}
        total={data?.meta.total ?? 0}
        page={t.page}
        pageSize={t.pageSize}
        sort={t.sort}
        onPageChange={t.setPage}
        onPageSizeChange={t.setPageSize}
        onSortChange={t.handleSort}
        onRowClick={(cn) => router.push(`/credit-notes/${cn.id}`)}
        isLoading={isLoading} isFetching={isPlaceholderData}
        emptyMessage={hasFilters ? "No credit notes match these filters." : "No credit notes yet — issue one from an invoice."}
      />
    </div>
  );
}
