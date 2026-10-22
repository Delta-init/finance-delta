"use client";

import { PAYMENT_METHODS, formatMoney, paymentMethodLabel } from "@delta/shared";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { usePayments, useDeletePaymentFromList, fetchAllPayments, type PaymentDTO } from "@/features/payments/api";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useCan } from "@/lib/use-can";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MoneyDisplay } from "@/components/ui/money";
import { ExportButton } from "@/components/ui/export-button";
import { useTableQuery } from "@/lib/use-table-query";
import { countFilters, useUrlParam } from "@/lib/url-state";
import { FilterToggle } from "@/components/ui/filter-toggle";
import { DateRangeQuick, useUrlDateRange } from "@/components/ui/date-range-quick";
import type { ExportColumn } from "@/lib/export";
import { CreditCard, Search, X, Printer, Trash2 } from "lucide-react";

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
  // In the address bar (2026-10-22), folded away until Filters is pressed.
  const [method, setMethod] = useUrlParam("method", "all");
  // When it was paid: Today, This week, This month, Last 30 days or Custom (2026-10-22) — beside the search.
  const paid = useUrlDateRange({ fromKey: "from", toKey: "to" });
  const dateFrom = paid.from, dateTo = paid.to;
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterCount = countFilters(method);


  const queryParams = {
    ...t.baseParams,
    method: method === "all" ? undefined : method,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
  };
  const { data, isLoading } = usePayments(queryParams);
  // Deleting a payment is the broad invoice right, as on the invoice itself (2026-10-16).
  const { can } = useCan();
  const canDelete = can("invoice:write");
  const del = useDeletePaymentFromList();
  const [deleting, setDeleting] = useState<PaymentDTO | null>(null);

  const hasFilters = method !== "all" || paid.range !== "all" || !!t.q;
  const clear = () => { setMethod("all"); paid.setRange("all"); t.setQ(""); };

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
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={(e) => { e.stopPropagation(); router.push(`/invoices/${p.invoiceId}/payments/${p.id}/receipt`); }}
            className="inline-flex items-center gap-1 text-xs text-foreground-muted hover:text-foreground"
            title="Receipt PDF"
          >
            <Printer className="h-3.5 w-3.5" />
          </button>
          {canDelete && (
            <button
              onClick={(e) => { e.stopPropagation(); setDeleting(p); }}
              className="inline-flex items-center gap-1 text-xs text-foreground-muted hover:text-danger"
              title="Delete payment"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
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
          <div className="flex items-center gap-2">
            <FilterToggle open={filtersOpen} onToggle={() => setFiltersOpen((o) => !o)} count={filterCount} />
            <ExportButton
              resource="payments"
              params={queryParams}
              fetchRows={() => fetchAllPayments(queryParams)}
              columns={PAYMENTS_EXPORT_COLUMNS}
              filename="payments"
              title="Payments"
              size="md"
            />
          </div>
        }
      />

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface p-3">
        <Field label="Search">
          <div className="relative min-w-[200px]">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle" />
            <Input value={t.q} onChange={(e) => t.setQ(e.target.value)} placeholder="Invoice # or customer…" className="pl-8 w-52" />
          </div>
        </Field>
        <Field label="Paid"><DateRangeQuick value={paid} /></Field>
        {filtersOpen && (<>
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
        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={clear} className="self-end">
            <X className="h-4 w-4" /> Clear
          </Button>
        )}
        </>)}
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

      <Dialog open={!!deleting} onOpenChange={(o) => { if (!o) setDeleting(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete this payment?</DialogTitle>
            <DialogDescription>
              {deleting
                ? `${formatMoney(deleting.amountMinor, deleting.currency)} recorded on ${deleting.paidOn} comes off ${deleting.invoiceNumber} (${deleting.customerName}): its balance goes back up by the same amount, and its receipt and bank line go with it. This cannot be undone.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setDeleting(null)}>Cancel</Button>
            <Button
              variant="destructive"
              loading={del.isPending}
              onClick={async () => {
                if (!deleting) return;
                try {
                  await del.mutateAsync({ invoiceId: deleting.invoiceId, paymentId: deleting.id });
                  toast.success("Payment deleted");
                  setDeleting(null);
                } catch (err) {
                  toast.error(err instanceof ApiError ? err.message : "Could not delete this payment");
                }
              }}
            >
              Delete payment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
