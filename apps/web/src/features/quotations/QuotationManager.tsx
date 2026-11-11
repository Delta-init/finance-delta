"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Search, X, FileText } from "lucide-react";
import { QUOTE_STATUSES, type Quotation, type QuoteStatus } from "@delta/shared";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { ExportButton } from "@/components/ui/export-button";
import type { ExportColumn } from "@/lib/export";
import { DatePicker } from "@/components/ui/date-picker";
import { MoneyDisplay } from "@/components/ui/money";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TagList } from "@/features/tags/TagBadge";
import { TagPicker } from "@/features/tags/TagPicker";
import { useTableQuery } from "@/lib/use-table-query";
import { useQuotations } from "./api";
import { QUOTE_STATUS_TONE } from "./status";

const QUOTATION_EXPORT_COLUMNS: ExportColumn<Quotation>[] = [
  { header: "Quote #", value: (q) => q.quoteNumber },
  { header: "Customer", value: (q) => q.customerName },
  { header: "Issue Date", value: (q) => q.issueDate },
  { header: "Expiry Date", value: (q) => q.expiryDate },
  { header: "Status", value: (q) => q.status },
  { header: "Currency", value: (q) => q.currency },
  { header: "Total", value: (q) => q.totalMinor / 100 },
];

export function QuotationManager() {
  const router = useRouter();
  const t = useTableQuery({ initialSort: { key: "createdAt", dir: "desc" } });
  const [status, setStatus] = useState<QuoteStatus | "all">("all");
  const [issueFrom, setIssueFrom] = useState("");
  const [issueTo, setIssueTo] = useState("");
  const [expiryFrom, setExpiryFrom] = useState("");
  const [expiryTo, setExpiryTo] = useState("");
  const [tagIds, setTagIds] = useState<string[]>([]);

  useEffect(() => t.resetPage(), [status, issueFrom, issueTo, expiryFrom, expiryTo, tagIds]); // eslint-disable-line react-hooks/exhaustive-deps

  const queryParams = {
    ...t.baseParams,
    status: status === "all" ? undefined : status,
    issueFrom: issueFrom || undefined,
    issueTo: issueTo || undefined,
    expiryFrom: expiryFrom || undefined,
    expiryTo: expiryTo || undefined,
    tagIds: tagIds.length ? tagIds : undefined,
  };

  const { data, isLoading, isPlaceholderData } = useQuotations(queryParams);

  const hasFilters =
    status !== "all" || issueFrom || issueTo || expiryFrom || expiryTo || tagIds.length > 0;
  const clear = () => {
    setStatus("all");
    setIssueFrom("");
    setIssueTo("");
    setExpiryFrom("");
    setExpiryTo("");
    setTagIds([]);
  };

  const columns: Column<Quotation>[] = [
    {
      key: "number",
      header: "Quote #",
      sortable: true,
      cell: (q) => (
        <span className="inline-flex items-center gap-1.5">
          <Link href={`/quotations/${q.id}`} className="font-medium text-primary hover:underline">
            {q.quoteNumber}
          </Link>
          {/* Made at a CRM close (2026-11-11): approved in Approvals, where it becomes the invoice. */}
          {q.enrolment && (
            <span className="rounded-full bg-surface-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-foreground-muted" title="An enrolment's quote — approved in Approvals, where it becomes the invoice for the whole fee">
              Enrolment
            </span>
          )}
        </span>
      ),
    },
    { key: "customer", header: "Customer", sortable: true, cell: (q) => q.customerName },
    { key: "tags", header: "Tags", cell: (q) => <TagList tags={q.tags} /> },
    { key: "issue", header: "Issue", sortable: true, cell: (q) => <span className="text-foreground-muted">{q.issueDate}</span> },
    { key: "expiry", header: "Expiry", sortable: true, cell: (q) => <span className="text-foreground-muted">{q.enrolment ? "—" : q.expiryDate}</span> },
    {
      key: "status",
      header: "Status",
      sortable: true,
      cell: (q) => (
        <span className="inline-flex flex-wrap items-center gap-1">
          <Badge tone={QUOTE_STATUS_TONE[q.status]} className="capitalize">
            {q.enrolment && q.status === "sent" ? "Waiting for approval" : q.enrolment && q.status === "draft" ? "Sent back" : q.status}
          </Badge>
          {(q.invoicedMinor ?? 0) > 0 && (
            <Badge tone={(q.invoicedMinor ?? 0) >= q.totalMinor ? "success" : "warning"}>
              {(q.invoicedMinor ?? 0) >= q.totalMinor ? "Invoiced" : "Partially invoiced"}
            </Badge>
          )}
        </span>
      ),
    },
    {
      key: "total",
      header: "Total",
      align: "right",
      sortable: true,
      cell: (q) => <MoneyDisplay minor={q.totalMinor} currency={q.currency} className="font-medium" />,
    },
  ];

  return (
    <div className="space-y-4 p-6">
      <PageHeader
        icon={FileText}
        title="Quotations"
        description="Create, send and track quotes through to accepted orders. An enrolment closed in a CRM starts here as a quote and becomes its invoice when approved."
        action={
          <div className="flex items-center gap-2">
            <ExportButton
              resource="quotations"
              params={queryParams}
              columns={QUOTATION_EXPORT_COLUMNS}
              filename="quotations"
              title="Quotations"
              size="md"
            />
            <Button onClick={() => router.push("/quotations/new")}>
              <Plus className="h-4 w-4" /> New quotation
            </Button>
          </div>
        }
      />

      {/* filters */}
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface p-3">
        <div className="relative min-w-[200px] flex-1">
          <label className="mb-1 block text-xs font-medium text-foreground-muted">Search</label>
          <div className="relative w-full h-full">
            <Search className="pointer-events-none absolute left-2.5 h-4 w-4 top-1/2 -translate-y-1/2 text-foreground-subtle" />
          <Input value={t.q} onChange={(e) => t.setQ(e.target.value)} placeholder="Quote # or customer…" className="pl-8" />
          </div>
        </div>
      
        <Field label="Issue from"><DatePicker value={issueFrom} onChange={setIssueFrom} clearable placeholder="Any" className="w-[150px]" /></Field>
        <Field label="Issue to"><DatePicker value={issueTo} onChange={setIssueTo} clearable placeholder="Any" className="w-[150px]" /></Field>
        <Field label="Expiry from"><DatePicker value={expiryFrom} onChange={setExpiryFrom} clearable placeholder="Any" className="w-[150px]" /></Field>
        <Field label="Expiry to"><DatePicker  value={expiryTo} onChange={setExpiryTo} clearable placeholder="Any" className="w-[150px]" /></Field>
        <Field label="Tags"><div className="w-[200px]"><TagPicker value={tagIds} onChange={setTagIds} placeholder="Any tags…" /></div></Field>
          <Field label="Status">
          <Select value={status} onValueChange={(v) => setStatus(v as QuoteStatus | "all")}>
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              {QUOTE_STATUSES.map((s) => (
                <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={clear}>
            <X className="h-4 w-4" /> Clear
          </Button>
        )}
      </div>

      <DataTable
        columns={columns}
        data={data?.data}
        getRowId={(q) => q.id}
        total={data?.meta.total ?? 0}
        page={t.page}
        pageSize={t.pageSize}
        sort={t.sort}
        onPageChange={t.setPage}
        onPageSizeChange={t.setPageSize}
        onSortChange={t.handleSort}
        selectable
        isLoading={isLoading} isFetching={isPlaceholderData}
        emptyMessage="No quotations match your filters."
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
