"use client";

import { PAYMENT_METHODS, paymentMethodLabel } from "@delta/shared";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { usePayments, type PaymentDTO } from "@/features/payments/api";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataTable, type Column } from "@/components/ui/data-table";
import { DatePicker } from "@/components/ui/date-picker";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MoneyDisplay } from "@/components/ui/money";
import { ExportButton } from "@/components/ui/export-button";
import { useTableQuery } from "@/lib/use-table-query";
import type { ExportColumn } from "@/lib/export";
import { CreditCard, Search, X, Printer } from "lucide-react";

// The list an invoice payment can actually use, so the filter cannot offer a
// method no payment will ever have.
const METHODS = PAYMENT_METHODS;

const PAYMENTS_EXPORT_COLUMNS: ExportColumn<PaymentDTO>[] = [
  { header: "Date", value: (p) => p.paidOn },
  { header: "Invoice", value: (p) => p.invoiceNumber },
  { header: "Customer", value: (p) => p.customerName },
  { header: "Method", value: (p) => paymentMethodLabel(p.method) },
  { header: "Account", value: (p) => p.accountName || "" },
  { header: "Reference", value: (p) => p.reference || "" },
  { header: "Amount", value: (p) => p.amountMinor / 100 },
  { header: "Currency", value: (p) => p.currency },
];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-foreground-muted">{label}</label>
      {children}
    </div>
  );
}

export default function PaymentsPage() {
  const router = useRouter();
  const t = useTableQuery({ initialSort: { key: "paidOn", dir: "desc" } });
  const [method, setMethod] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  useEffect(() => t.resetPage(), [method, dateFrom, dateTo]); // eslint-disable-line react-hooks/exhaustive-deps

  const queryParams = {
    ...t.baseParams,
    method: method === "all" ? undefined : method,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
  };
  const { data, isLoading } = usePayments(queryParams);

  const hasFilters = method !== "all" || !!dateFrom || !!dateTo || !!t.q;
  const clear = () => { setMethod("all"); setDateFrom(""); setDateTo(""); t.setQ(""); };

  const columns: Column<PaymentDTO>[] = [
    {
      key: "paidOn",
      header: "Date",
      sortable: true,
      cell: (p) => <span className="text-foreground-muted">{p.paidOn}</span>,
    },
    {
      key: "invoice",
      header: "Invoice",
      sortable: true,
      cell: (p) => (
        <Link href={`/invoices/${p.invoiceId}`} className="font-medium text-primary hover:underline">
          {p.invoiceNumber}
        </Link>
      ),
    },
    {
      key: "customer",
      header: "Customer",
      sortable: true,
      cell: (p) => p.customerName,
    },
    {
      key: "method",
      header: "Method",
      sortable: true,
      cell: (p) => <span className="capitalize text-foreground-muted">{paymentMethodLabel(p.method)}</span>,
    },
    {
      key: "account",
      header: "Account",
      cell: (p) => <span className="text-foreground-muted">{p.accountName || "—"}</span>,
    },
    {
      key: "reference",
      header: "Reference",
      cell: (p) => <span className="text-foreground-muted">{p.reference || "—"}</span>,
    },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      sortable: true,
      cell: (p) => <MoneyDisplay minor={p.amountMinor} currency={p.currency} className="font-medium text-success" />,
    },
    {
      key: "actions",
      header: "",
      cell: (p) => (
        <button
          onClick={(e) => { e.stopPropagation(); router.push(`/invoices/${p.invoiceId}/payments/${p.id}/receipt`); }}
          className="inline-flex items-center gap-1 text-xs text-foreground-muted hover:text-foreground"
          title="Receipt PDF"
        >
          <Printer className="h-3.5 w-3.5" />
        </button>
      ),
    },
  ];

  return (
    <div className="space-y-4 p-6">
      <PageHeader
        icon={CreditCard}
        title="Payments"
        description="All payments received across invoices"
        action={
          <ExportButton
            resource="payments"
            params={queryParams}
            columns={PAYMENTS_EXPORT_COLUMNS}
            filename="payments"
            title="Payments"
            size="md"
          />
        }
      />

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface p-3">
        <Field label="Search">
          <div className="relative min-w-[200px]">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle" />
            <Input value={t.q} onChange={(e) => t.setQ(e.target.value)} placeholder="Invoice # or customer…" className="pl-8 w-52" />
          </div>
        </Field>
        <Field label="Method">
          <Select value={method} onValueChange={(v) => setMethod(v)}>
            <SelectTrigger className="w-[150px]">
              <SelectValue placeholder="All methods" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All methods</SelectItem>
              {METHODS.map((m) => (
                <SelectItem key={m} value={m} className="capitalize">
                  {paymentMethodLabel(m)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Date from">
          <DatePicker value={dateFrom} onChange={setDateFrom} clearable placeholder="Any" className="w-[150px]" />
        </Field>
        <Field label="Date to">
          <DatePicker value={dateTo} onChange={setDateTo} clearable placeholder="Any" className="w-[150px]" />
        </Field>
        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={clear} className="self-end">
            <X className="h-4 w-4" /> Clear
          </Button>
        )}
        {data?.meta && (
          <p className="ml-auto self-end text-xs text-foreground-muted">
            {data.meta.total} payment{data.meta.total !== 1 ? "s" : ""}
          </p>
        )}
      </div>

      <DataTable
        columns={columns}
        data={data?.data}
        getRowId={(p) => p.id}
        total={data?.meta.total ?? 0}
        page={t.page}
        pageSize={t.pageSize}
        sort={t.sort}
        onPageChange={t.setPage}
        onPageSizeChange={t.setPageSize}
        onSortChange={t.handleSort}
        isLoading={isLoading}
        emptyMessage="No payments found."
      />
    </div>
  );
}
