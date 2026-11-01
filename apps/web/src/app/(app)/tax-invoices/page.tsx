"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { formatMoney, paymentMethodLabel, type Customer, type Invoice } from "@delta/shared";
import { api, ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { DataTable, type Column } from "@/components/ui/data-table";
import { MoneyDisplay } from "@/components/ui/money";
import { ExportButton } from "@/components/ui/export-button";
import { DateRangeQuick, useUrlDateRange } from "@/components/ui/date-range-quick";
import { useUrlParam } from "@/lib/url-state";
import type { ExportColumn } from "@/lib/export";
import { useOrganization } from "@/features/organization/api";
import { downloadTaxInvoicePdf } from "@/features/invoices/invoice-pdf";
import { useTaxInvoices, type ProformaRow, type TaxInvoiceRow } from "@/features/tax-invoices/api";
import { Download, FileCheck2, Search } from "lucide-react";

type Tab = "tis" | "proformas";
const TABS: Array<{ key: Tab; label: string }> = [
  { key: "tis", label: "Tax invoices" },
  { key: "proformas", label: "Pro-formas" },
];

const TI_EXPORT: ExportColumn<TaxInvoiceRow>[] = [
  { header: "Tax invoice", value: (t) => t.number + (t.cancelled ? " (cancelled)" : "") },
  { header: "Paid on", value: (t) => t.paidOn },
  { header: "Customer", value: (t) => t.customerName },
  { header: "Against", value: (t) => t.invoiceNumber },
  { header: "Method", value: (t) => (t.method ? paymentMethodLabel(t.method) : "") },
  { header: "Net", value: (t) => t.netMinor / 100 },
  { header: "VAT", value: (t) => t.taxMinor / 100 },
  { header: "Total", value: (t) => t.amountMinor / 100 },
  { header: "Currency", value: (t) => t.currency },
  { header: "Emailed", value: (t) => (t.emailed ? "Yes" : "No") },
];
const PROFORMA_EXPORT: ExportColumn<ProformaRow>[] = [
  { header: "Invoice", value: (p) => p.invoiceNumber },
  { header: "Issued", value: (p) => p.issueDate },
  { header: "Customer", value: (p) => p.customerName },
  { header: "Course", value: (p) => p.course },
  { header: "Salesperson", value: (p) => p.salespersonName },
  { header: "Total", value: (p) => p.totalMinor / 100 },
  { header: "Paid", value: (p) => p.amountPaidMinor / 100 },
  { header: "Balance", value: (p) => p.balanceMinor / 100 },
  { header: "Currency", value: (p) => p.currency },
  { header: "Tax invoices", value: (p) => p.taxInvoices.join(", ") },
];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-foreground-muted">{label}</label>
      {children}
    </div>
  );
}

/**
 * Sales → Pro-formas & tax invoices (the user, 2026-11-01): with VAT on payments received, a part-paid enrolment's
 * invoice is a pro-forma and each payment towards it its own tax invoice. Both here, by the day paid, with the VAT the
 * tax invoices carry — the figure the VAT report counts.
 */
export default function TaxInvoicesPage() {
  const [tabParam, setTabParam] = useUrlParam("tab", "tis");
  const tab: Tab = tabParam === "proformas" ? "proformas" : "tis";
  const [q, setQ] = useUrlParam("q", "");
  const [search, setSearch] = useState(q);
  useEffect(() => {
    const t = setTimeout(() => { if (search !== q) setQ(search); }, 300);
    return () => clearTimeout(t);
  }, [search, q, setQ]);
  const paid = useUrlDateRange({ fromKey: "from", toKey: "to" });
  const params = { from: paid.from || undefined, to: paid.to || undefined, q: q || undefined };
  const { data, isLoading, isPlaceholderData } = useTaxInvoices(params);
  const { data: org } = useOrganization();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  useEffect(() => setPage(1), [tab, paid.from, paid.to, q]);
  const [busy, setBusy] = useState<string | null>(null);

  async function pdf(t: TaxInvoiceRow) {
    setBusy(t.number);
    try {
      const invoice = await api.get<Invoice>(`invoices/${t.invoiceId}`);
      const payment = invoice.payments.find((p) => p.id === t.paymentId);
      if (!payment?.taxInvoice) throw new Error("That payment's tax invoice is not there any more");
      const customer = await api.get<Customer>(`customers/${t.customerId}`).catch(() => null);
      await downloadTaxInvoicePdf({ invoice, payment, org, customer });
    } catch (e) {
      toast.error(e instanceof ApiError || e instanceof Error ? e.message : "Could not draw the tax invoice");
    } finally {
      setBusy(null);
    }
  }

  const tiColumns: Column<TaxInvoiceRow>[] = [
    {
      key: "number", header: "Tax invoice",
      cell: (t) => (
        <span className={t.cancelled ? "text-foreground-muted line-through" : "font-medium"}>
          {t.number}
          {t.cancelled && <Badge tone="neutral" className="ml-2 no-underline">Cancelled</Badge>}
        </span>
      ),
    },
    { key: "paidOn", header: "Paid on", cell: (t) => <span className="text-foreground-muted">{t.paidOn}</span> },
    { key: "customer", header: "Customer", cell: (t) => t.customerName },
    {
      key: "against", header: "Against",
      cell: (t) => <Link href={`/invoices/${t.invoiceId}`} className="text-primary hover:underline" onClick={(e) => e.stopPropagation()}>{t.invoiceNumber}</Link>,
    },
    { key: "method", header: "Method", cell: (t) => <span className="text-foreground-muted">{t.method ? paymentMethodLabel(t.method) : "—"}</span> },
    { key: "net", header: "Net", align: "right", cell: (t) => <MoneyDisplay minor={t.netMinor} currency={t.currency} /> },
    { key: "tax", header: "VAT", align: "right", cell: (t) => <MoneyDisplay minor={t.taxMinor} currency={t.currency} className="font-medium" /> },
    { key: "amount", header: "Total", align: "right", cell: (t) => <MoneyDisplay minor={t.amountMinor} currency={t.currency} className="font-medium text-success" /> },
    { key: "emailed", header: "Emailed", cell: (t) => (t.cancelled ? "—" : t.emailed ? <Badge tone="success">Sent</Badge> : <Badge tone="neutral">Not sent</Badge>) },
    {
      key: "pdf", header: "", hideInDetail: true,
      cell: (t) => !t.cancelled && (
        <button
          onClick={(e) => { e.stopPropagation(); void pdf(t); }}
          disabled={busy === t.number}
          className="inline-flex items-center gap-1 text-xs text-foreground-muted hover:text-foreground disabled:opacity-50"
          title="Download this tax invoice"
        >
          <Download className="h-3.5 w-3.5" /> PDF
        </button>
      ),
    },
  ];

  const proformaColumns: Column<ProformaRow>[] = [
    {
      key: "number", header: "Invoice",
      cell: (p) => <Link href={`/invoices/${p.id}`} className="font-medium text-primary hover:underline" onClick={(e) => e.stopPropagation()}>{p.invoiceNumber}</Link>,
    },
    { key: "issued", header: "Issued", cell: (p) => <span className="text-foreground-muted">{p.issueDate}</span> },
    { key: "customer", header: "Customer", cell: (p) => p.customerName },
    { key: "course", header: "Course", cell: (p) => <span className="text-foreground-muted">{p.course || "—"}</span> },
    { key: "total", header: "Total", align: "right", cell: (p) => <MoneyDisplay minor={p.totalMinor} currency={p.currency} /> },
    { key: "paid", header: "Paid", align: "right", cell: (p) => <MoneyDisplay minor={p.amountPaidMinor} currency={p.currency} className="text-success" /> },
    { key: "balance", header: "Balance", align: "right", cell: (p) => <MoneyDisplay minor={p.balanceMinor} currency={p.currency} className={p.balanceMinor > 0 ? "font-medium text-warning" : ""} /> },
    { key: "tis", header: "Tax invoices", cell: (p) => <span className="text-xs text-foreground-muted">{p.taxInvoices.join(", ") || "—"}</span> },
  ];

  const tis = data?.taxInvoices ?? [];
  const proformas = data?.proformas ?? [];
  const rows = tab === "tis" ? tis : proformas;
  const shown = rows.slice((page - 1) * pageSize, page * pageSize);
  const totals = Object.entries(data?.totals ?? {});
  const exportName = `${tab === "tis" ? "tax-invoices" : "proformas"}${paid.from ? `-${paid.from}` : ""}${paid.to ? `-to-${paid.to}` : ""}`;

  return (
    <div className="space-y-4 p-6">
      <PageHeader
        icon={FileCheck2}
        title="Pro-formas & tax invoices"
        description="Part-paid enrolments are pro-formas; each payment towards one has its own tax invoice with the VAT on that payment"
        action={tab === "tis" ? (
          <ExportButton resource="invoices/tax-invoices" params={params} fetchRows={async () => tis} columns={TI_EXPORT} filename={exportName} title="Tax invoices" size="md" />
        ) : (
          <ExportButton resource="invoices/tax-invoices" params={params} fetchRows={async () => proformas} columns={PROFORMA_EXPORT} filename={exportName} title="Pro-formas" size="md" />
        )}
      />

      <div className="flex w-fit gap-1 rounded-lg border border-border bg-surface p-1 text-sm" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTabParam(t.key)}
            className={`rounded-md px-3 py-1.5 font-medium ${tab === t.key ? "bg-primary text-primary-foreground" : "text-foreground-muted hover:bg-surface-muted"}`}
          >
            {t.label}
            <span className="ml-1.5 tabular-nums">({t.key === "tis" ? tis.filter((x) => !x.cancelled).length : proformas.length})</span>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface p-3">
        <Field label="Search">
          <div className="relative min-w-[200px]">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="TI-, IN- or customer…" className="pl-8 w-56" />
          </div>
        </Field>
        <Field label={tab === "tis" ? "Paid" : "Issued or paid"}><DateRangeQuick value={paid} /></Field>
      </div>

      {/* What the tax invoices in the period come to — the VAT the VAT report counts for them. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {totals.length === 0 ? (
          <div className="rounded-lg border border-border bg-surface p-4 text-sm text-foreground-muted">No tax invoices in this period.</div>
        ) : totals.flatMap(([cur, t]) => [
          <div key={`${cur}-n`} className="rounded-lg border border-border bg-surface p-4">
            <p className="text-xs text-foreground-muted">Tax invoices{totals.length > 1 ? ` · ${cur}` : ""}</p>
            <p className="mt-1 text-lg font-semibold tabular-nums">{t.count}</p>
          </div>,
          <div key={`${cur}-a`} className="rounded-lg border border-border bg-surface p-4">
            <p className="text-xs text-foreground-muted">Received</p>
            <p className="mt-1 text-lg font-semibold tabular-nums">{formatMoney(t.amountMinor, cur)}</p>
          </div>,
          <div key={`${cur}-net`} className="rounded-lg border border-border bg-surface p-4">
            <p className="text-xs text-foreground-muted">Net</p>
            <p className="mt-1 text-lg font-semibold tabular-nums">{formatMoney(t.netMinor, cur)}</p>
          </div>,
          <div key={`${cur}-vat`} className="rounded-lg border border-border bg-surface p-4">
            <p className="text-xs text-foreground-muted">VAT</p>
            <p className="mt-1 text-lg font-semibold tabular-nums text-primary">{formatMoney(t.taxMinor, cur)}</p>
          </div>,
        ])}
      </div>

      {tab === "tis" ? (
        <DataTable
          columns={tiColumns}
          data={isLoading ? undefined : (shown as TaxInvoiceRow[])}
          getRowId={(t) => `${t.number}-${t.invoiceId}`}
          total={rows.length}
          page={page}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={(n) => { setPageSize(n); setPage(1); }}
          isLoading={isLoading}
          isFetching={isPlaceholderData}
          emptyMessage={org && !org.vatOnPayments ? "VAT on payments received is off — turn it on in Settings." : "No tax invoices in this period."}
        />
      ) : (
        <DataTable
          columns={proformaColumns}
          data={isLoading ? undefined : (shown as ProformaRow[])}
          getRowId={(p) => p.id}
          total={rows.length}
          page={page}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={(n) => { setPageSize(n); setPage(1); }}
          isLoading={isLoading}
          isFetching={isPlaceholderData}
          emptyMessage="No pro-formas in this period."
        />
      )}
    </div>
  );
}
