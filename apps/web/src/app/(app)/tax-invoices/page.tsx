"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { formatMoney, paidRateText, paymentMethodLabel, type Customer, type Invoice } from "@delta/shared";
import { api, ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataTable, type Column } from "@/components/ui/data-table";
import { MoneyDisplay } from "@/components/ui/money";
import { PaidProgress, paidPercent } from "@/components/ui/paid-progress";
import { ExportButton } from "@/components/ui/export-button";
import { DateRangeQuick, useUrlDateRange } from "@/components/ui/date-range-quick";
import { useUrlParam } from "@/lib/url-state";
import type { ExportColumn } from "@/lib/export";
import { useOrganization } from "@/features/organization/api";
import { downloadTaxInvoicePdf } from "@/features/invoices/invoice-pdf";
import { useTaxDocuments, useTaxInvoices, type ProformaRow, type TaxDocumentRow, type TaxInvoiceRow } from "@/features/tax-invoices/api";
import { Download, FileCheck2, Search } from "lucide-react";

type Tab = "all" | "tis" | "proformas";
const TABS: Array<{ key: Tab; label: string }> = [
  { key: "all", label: "All tax documents" },
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
  { header: "Paid in", value: (t) => t.paidCurrency || t.currency },
  { header: "Amount paid in it", value: (t) => (t.paidCurrency && (t.paidAmountMinor ?? 0) > 0 ? (t.paidAmountMinor ?? 0) / 100 : "") },
];
const DOC_EXPORT: ExportColumn<TaxDocumentRow>[] = [
  { header: "Document", value: (d) => d.number },
  { header: "Type", value: (d) => (d.kind === "ti" ? "Tax invoice (TI)" : "Invoice") },
  { header: "Date", value: (d) => d.date },
  { header: "Customer", value: (d) => d.customerName },
  { header: "Against", value: (d) => (d.kind === "ti" ? d.invoiceNumber : "") },
  { header: "Method", value: (d) => (d.method ? paymentMethodLabel(d.method) : "") },
  { header: "Net", value: (d) => d.netMinor / 100 },
  { header: "VAT", value: (d) => d.taxMinor / 100 },
  { header: "Total", value: (d) => d.amountMinor / 100 },
  { header: "Fee", value: (d) => d.feeMinor / 100 },
  { header: "Paid", value: (d) => d.paidMinor / 100 },
  { header: "Paid %", value: (d) => paidPercent(d.paidMinor, d.feeMinor) },
  { header: "Pending", value: (d) => d.balanceMinor / 100 },
  { header: "Currency", value: (d) => d.currency },
  { header: "Paid in", value: (d) => (d.foreign.length ? d.foreign.map((f) => f.currency).join(" + ") : d.currency) },
  { header: "Amount paid in it", value: (d) => { const v = paidView(d); return v.known ? v.one!.amountMinor / 100 : ""; } },
  { header: "Recorded as", value: (d) => (d.foreignRecordedMinor > 0 ? d.foreignRecordedMinor / 100 : "") },
  { header: "Rate", value: (d) => { const v = paidView(d); return v.known ? paidRateText(v.one!.currency, v.one!.amountMinor, d.currency, v.one!.recordedMinor) : ""; } },
  { header: "Fee in it", value: (d) => { const v = paidView(d); return v.feeMinor ? v.feeMinor / 100 : ""; } },
];

/**
 * A document paid in another currency, as it is shown (2026-11-13: "whichever currency they are giving, that currency
 * needs to reflect — no need to convert anywhere … and the product amount in it"): the one other currency it was paid
 * in (when there is just one), whether its amount was recorded, whether all of the document was paid so, and the fee
 * and what is owed at the rate that payment itself was taken at.
 */
function paidView(d: TaxDocumentRow) {
  const isOther = d.foreignRecordedMinor > 0;
  const one = d.foreign.length === 1 ? d.foreign[0]! : null;
  const known = !!one && one.amountMinor > 0 && one.recordedMinor > 0 && (d.kind === "ti" || d.invForeignKnownMinor >= d.invForeignRecordedMinor);
  const whole = isOther && d.foreignRecordedMinor >= d.amountMinor;
  const rate = known ? one!.amountMinor / one!.recordedMinor : 0;
  const inIt = (minor: number) => Math.round(minor * rate);
  // Everything paid on the invoice so far was in that one currency, each amount recorded: Paid can be said in it.
  const all = d.invForeign.length === 1 ? d.invForeign[0]! : null;
  const allPaidInIt = known && !!all && all.currency === one!.currency && d.paidMinor > 0 && d.invForeignRecordedMinor >= d.paidMinor && d.invForeignKnownMinor >= d.invForeignRecordedMinor;
  return { isOther, one, known, whole, currency: one?.currency ?? "", feeMinor: rate ? inIt(d.feeMinor) : 0, pendingMinor: rate ? inIt(d.balanceMinor) : 0, allPaidInIt, paidInItMinor: all?.amountMinor ?? 0 };
}
const small = "text-[11px] leading-4 text-foreground-muted";
const PROFORMA_EXPORT: ExportColumn<ProformaRow>[] = [
  { header: "Invoice", value: (p) => p.invoiceNumber },
  { header: "Issued", value: (p) => p.issueDate },
  { header: "Customer", value: (p) => p.customerName },
  { header: "Course", value: (p) => p.course },
  { header: "Salesperson", value: (p) => p.salespersonName },
  { header: "Total", value: (p) => p.totalMinor / 100 },
  { header: "Paid", value: (p) => p.amountPaidMinor / 100 },
  { header: "Paid %", value: (p) => paidPercent(p.amountPaidMinor, p.totalMinor) },
  { header: "Balance", value: (p) => p.balanceMinor / 100 },
  { header: "Currency", value: (p) => p.currency },
  { header: "Tax invoices", value: (p) => p.taxInvoices.join(", ") },
  { header: "Paid in other currencies", value: (p) => (p.foreign ?? []).filter((f) => f.amountMinor > 0).map((f) => formatMoney(f.amountMinor, f.currency)).join(" + ") },
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
 *
 * All tax documents (2026-11-12, "all in one place … paid, progress, pending"): the first tab — every invoice with
 * every payment tax invoice in one list, a page at a time from the server, coming to the VAT report's output VAT for
 * the same days. A TI's paid, progress and pending are its pro-forma's.
 */
export default function TaxInvoicesPage() {
  const [tabParam, setTabParam] = useUrlParam("tab", "all");
  const tab: Tab = tabParam === "tis" || tabParam === "proformas" ? tabParam : "all";
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
  // All tax documents: only the invoices or only the TIs, and only what still has something owed.
  const [docType, setDocType] = useUrlParam<"all" | "invoice" | "ti">("type", "all", { allowed: ["invoice", "ti"] });
  const [pending, setPending] = useUrlParam<"all" | "yes">("pending", "all", { allowed: ["yes"] });
  // …and only what was paid in rupees, or only what was not (2026-11-13).
  const [paidInParam, setPaidIn] = useUrlParam("paidIn", "all");
  const paidIn = /^(own|other|[A-Za-z]{3})$/.test(paidInParam) ? paidInParam : "all";
  const docParams = {
    ...params, type: docType === "all" ? undefined : docType, pending: pending === "yes" ? ("yes" as const) : undefined,
    paidIn: paidIn === "all" ? undefined : paidIn,
  };
  const docs = useTaxDocuments({ ...docParams, page: tab === "all" ? page : 1, pageSize });
  useEffect(() => setPage(1), [tab, paid.from, paid.to, q, docType, pending, paidIn]);
  const [busy, setBusy] = useState<string | null>(null);

  async function pdf(t: Pick<TaxInvoiceRow, "number" | "invoiceId" | "paymentId" | "customerId">) {
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
    {
      // Paid in rupees: the rupees, never only what they were converted to (2026-11-13).
      key: "amount", header: "Total", align: "right",
      cell: (t) => t.paidCurrency && (t.paidAmountMinor ?? 0) > 0 ? (
        <div>
          <span className="font-medium tabular-nums text-success">{formatMoney(t.paidAmountMinor ?? 0, t.paidCurrency)}</span>
          <p className={small}>recorded as {formatMoney(t.amountMinor, t.currency)}</p>
        </div>
      ) : (
        <div>
          <MoneyDisplay minor={t.amountMinor} currency={t.currency} className="font-medium text-success" />
          {t.paidCurrency && <p className={small}>paid in {t.paidCurrency} — the amount was not recorded</p>}
        </div>
      ),
    },
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
    {
      key: "paid", header: "Paid", align: "right",
      cell: (p) => {
        // Each currency as it was paid: the invoice's own first, then every other on its own line.
        const other = (p.foreign ?? []).filter((f) => f.amountMinor > 0);
        const own = p.amountPaidMinor - (p.foreignRecordedMinor ?? 0);
        if (!other.length) return <MoneyDisplay minor={p.amountPaidMinor} currency={p.currency} className="text-success" />;
        return (
          <div>
            {own > 0 && <MoneyDisplay minor={own} currency={p.currency} className="text-success" />}
            {other.map((f, i) => (
              <p key={f.currency} className={own > 0 || i > 0 ? small : "tabular-nums text-success"}>{own > 0 || i > 0 ? "+ " : ""}{formatMoney(f.amountMinor, f.currency)}</p>
            ))}
            {own <= 0 && <p className={small}>recorded as {formatMoney(p.amountPaidMinor, p.currency)}</p>}
          </div>
        );
      },
    },
    { key: "balance", header: "Balance", align: "right", cell: (p) => <MoneyDisplay minor={p.balanceMinor} currency={p.currency} className={p.balanceMinor > 0 ? "font-medium text-warning" : ""} /> },
    // How far the fee is paid (2026-11-12) — the same bar as on the Invoices list.
    { key: "progress", header: "Progress", cell: (p) => <PaidProgress paidMinor={p.amountPaidMinor} totalMinor={p.totalMinor} /> },
    { key: "tis", header: "Tax invoices", cell: (p) => <span className="text-xs text-foreground-muted">{p.taxInvoices.join(", ") || "—"}</span> },
  ];

  const docColumns: Column<TaxDocumentRow>[] = [
    {
      key: "number", header: "Document",
      cell: (d) => (
        <span className="inline-flex items-center gap-2">
          {d.kind === "invoice"
            ? <Link href={`/invoices/${d.invoiceId}`} className="font-medium text-primary hover:underline" onClick={(e) => e.stopPropagation()}>{d.number}</Link>
            : <span className="font-medium">{d.number}</span>}
          <Badge tone={d.kind === "ti" ? "success" : "primary"}>{d.kind === "ti" ? "TI" : "Invoice"}</Badge>
          {d.foreign.map((f) => <Badge key={f.currency} tone="warning" title={`Paid in ${f.currency}`}>{f.currency}</Badge>)}
        </span>
      ),
    },
    { key: "date", header: "Date", cell: (d) => <span className="text-foreground-muted">{d.date}</span> },
    { key: "customer", header: "Customer", cell: (d) => d.customerName },
    {
      key: "against", header: "Against",
      cell: (d) => d.kind === "ti"
        ? <Link href={`/invoices/${d.invoiceId}`} className="text-primary hover:underline" onClick={(e) => e.stopPropagation()}>{d.invoiceNumber}</Link>
        : <span className="text-foreground-muted">—</span>,
    },
    { key: "net", header: "Net", align: "right", cell: (d) => <MoneyDisplay minor={d.netMinor} currency={d.currency} /> },
    {
      // Only the invoice's own currency carries VAT: said so, rather than a nought, on a document paid in another.
      key: "tax", header: "VAT", align: "right",
      cell: (d) => d.taxMinor === 0 && d.foreignRecordedMinor > 0
        ? <span className="text-foreground-muted">No VAT</span>
        : <MoneyDisplay minor={d.taxMinor} currency={d.currency} className="font-medium" />,
    },
    {
      // Paid in another currency: that amount itself, never only what it was converted to.
      key: "amount", header: "Total", align: "right",
      cell: (d) => {
        const v = paidView(d);
        if (!v.isOther) return <MoneyDisplay minor={d.amountMinor} currency={d.currency} className="font-medium" />;
        if (v.known && v.whole) {
          return (
            <div>
              <span className="font-medium tabular-nums">{formatMoney(v.one!.amountMinor, v.one!.currency)}</span>
              <p className={small}>recorded as {formatMoney(d.amountMinor, d.currency)}</p>
              <p className={small}>{paidRateText(v.one!.currency, v.one!.amountMinor, d.currency, v.one!.recordedMinor)}</p>
            </div>
          );
        }
        return (
          <div>
            <MoneyDisplay minor={d.amountMinor} currency={d.currency} className="font-medium" />
            {d.foreign.map((f) => (
              <p key={f.currency} className={small}>
                {f.amountMinor > 0 ? `${formatMoney(f.amountMinor, f.currency)} of it paid in ${f.currency}` : `paid in ${f.currency} — the amount was not recorded`}
              </p>
            ))}
          </div>
        );
      },
    },
    {
      // Of the invoice — for a TI, of its pro-forma: the payment itself is the Total beside it. Each currency as paid.
      key: "paid", header: "Paid", align: "right",
      cell: (d) => {
        const v = paidView(d);
        if (v.allPaidInIt) {
          return (
            <div>
              <span className="tabular-nums text-success">{formatMoney(v.paidInItMinor, v.currency)}</span>
              <p className={small}>of {formatMoney(v.feeMinor, v.currency)} fee</p>
              <p className={small}>fee {formatMoney(d.feeMinor, d.currency)}</p>
            </div>
          );
        }
        const other = d.invForeign.filter((f) => f.amountMinor > 0);
        return (
          <div>
            <MoneyDisplay minor={d.paidMinor - d.invForeignKnownMinor} currency={d.currency} className="text-success" />
            {other.map((f) => <p key={f.currency} className={small}>+ {formatMoney(f.amountMinor, f.currency)}</p>)}
            {d.kind === "ti" && <p className={small}>of {formatMoney(d.feeMinor, d.currency)} fee</p>}
            {v.known && <p className={small}>fee {formatMoney(v.feeMinor, v.currency)} at this rate</p>}
          </div>
        );
      },
    },
    { key: "progress", header: "Progress", cell: (d) => <PaidProgress paidMinor={d.paidMinor} totalMinor={d.feeMinor} /> },
    {
      // What is owed is owed in the invoice's currency; the figure beside it is that at this payment's rate.
      key: "pending", header: "Pending", align: "right",
      cell: (d) => {
        if (!(d.balanceMinor > 0)) return <span className="text-foreground-muted">—</span>;
        const v = paidView(d);
        return (
          <div>
            <MoneyDisplay minor={d.balanceMinor} currency={d.currency} className="font-medium text-warning" />
            {v.known && <p className={small}>about {formatMoney(v.pendingMinor, v.currency)}</p>}
          </div>
        );
      },
    },
    {
      key: "pdf", header: "", hideInDetail: true,
      cell: (d) => d.kind === "ti" && (
        <button
          onClick={(e) => { e.stopPropagation(); void pdf(d); }}
          disabled={busy === d.number}
          className="inline-flex items-center gap-1 text-xs text-foreground-muted hover:text-foreground disabled:opacity-50"
          title="Download this tax invoice"
        >
          <Download className="h-3.5 w-3.5" /> PDF
        </button>
      ),
    },
  ];

  const tis = data?.taxInvoices ?? [];
  const proformas = data?.proformas ?? [];
  const rows = tab === "tis" ? tis : proformas;
  const shown = rows.slice((page - 1) * pageSize, page * pageSize);
  const totals = Object.entries(data?.totals ?? {});
  const docTotals = Object.entries(docs.data?.totals ?? {});
  // The currencies the Paid in filter offers: those in the list, and the one picked (it may now be the only one).
  const paidInCurrencies = [...new Set([...docTotals.flatMap(([, t]) => (t.foreign ?? []).map((f) => f.currency)), ...(/^[A-Za-z]{3}$/.test(paidIn) && paidIn !== "all" && paidIn !== "own" ? [paidIn.toUpperCase()] : [])])].sort();
  const exportName = `${tab === "all" ? "tax-documents" : tab === "tis" ? "tax-invoices" : "proformas"}${paid.from ? `-${paid.from}` : ""}${paid.to ? `-to-${paid.to}` : ""}`;

  return (
    <div className="space-y-4 p-6">
      <PageHeader
        icon={FileCheck2}
        title="Pro-formas & tax invoices"
        description="Every tax document in one place: the invoices, and for a part-paid enrolment (a pro-forma) a tax invoice for each payment, with the VAT on that payment"
        action={tab === "all" ? (
          <ExportButton resource="invoices/tax-documents" params={docParams} columns={DOC_EXPORT} filename={exportName} title="Tax documents" size="md" />
        ) : tab === "tis" ? (
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
            <span className="ml-1.5 tabular-nums">({t.key === "all" ? (docs.data?.total ?? 0) : t.key === "tis" ? tis.filter((x) => !x.cancelled).length : proformas.length})</span>
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
        <Field label={tab === "all" ? "Date" : tab === "tis" ? "Paid" : "Issued or paid"}><DateRangeQuick value={paid} /></Field>
        {tab === "all" && (
          <>
            <Field label="Type">
              <Select value={docType} onValueChange={(v) => setDocType(v as "all" | "invoice" | "ti")}>
                <SelectTrigger className="w-[170px]">
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="invoice">Invoices</SelectItem>
                  <SelectItem value="ti">Tax invoices (TI)</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Paid in">
              <Select value={paidIn} onValueChange={setPaidIn}>
                <SelectTrigger className="w-[190px]">
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="other">Other currencies</SelectItem>
                  <SelectItem value="own">The invoice's currency</SelectItem>
                  {paidInCurrencies.map((c) => <SelectItem key={c} value={c}>{c} only</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Balance">
              <Select value={pending} onValueChange={(v) => setPending(v as "all" | "yes")}>
                <SelectTrigger className="w-[150px]">
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="yes">Pending only</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </>
        )}
      </div>

      {/* All tax documents: what the list comes to — its VAT is the VAT report's output VAT for the same days. What was
          paid in another currency is counted on its own, a line for each (2026-11-13): it carries no VAT and is never
          shown only converted. */}
      {tab === "all" && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          {docTotals.length === 0 ? (
            <div className="rounded-lg border border-border bg-surface p-4 text-sm text-foreground-muted">{docs.isLoading ? "Loading…" : "No tax documents in this period."}</div>
          ) : docTotals.flatMap(([cur, t]) => [
            <div key={`${cur}-n`} className="rounded-lg border border-border bg-surface p-4">
              <p className="text-xs text-foreground-muted">Documents{docTotals.length > 1 ? ` · ${cur}` : ""}</p>
              <p className="mt-1 text-lg font-semibold tabular-nums">{t.count}</p>
            </div>,
            <div key={`${cur}-a`} className="rounded-lg border border-border bg-surface p-4" title="What the documents come to, without what was paid in other currencies">
              <p className="text-xs text-foreground-muted">Total in {cur}</p>
              <p className="mt-1 text-lg font-semibold tabular-nums">{formatMoney(t.amountMinor - t.foreignRecordedMinor, cur)}</p>
            </div>,
            <div key={`${cur}-net`} className="rounded-lg border border-border bg-surface p-4" title="Before VAT, without what was paid in other currencies">
              <p className="text-xs text-foreground-muted">Net ({cur})</p>
              <p className="mt-1 text-lg font-semibold tabular-nums">{formatMoney(t.netMinor - (t.foreignRecordedMinor - t.foreignTaxMinor), cur)}</p>
            </div>,
            <div key={`${cur}-vat`} className="rounded-lg border border-border bg-surface p-4" title="The VAT the VAT report counts for these days">
              <p className="text-xs text-foreground-muted">VAT ({cur})</p>
              <p className="mt-1 text-lg font-semibold tabular-nums text-primary">{formatMoney(t.taxMinor, cur)}</p>
            </div>,
            <div key={`${cur}-other`} className="rounded-lg border border-border bg-surface p-4" title="What clients actually paid in other currencies — each on its own, no VAT on it">
              <p className="text-xs text-foreground-muted">Paid in other currencies</p>
              {(t.foreign ?? []).length === 0 ? (
                <p className="mt-1 text-lg font-semibold text-foreground-subtle">—</p>
              ) : (
                <>
                  {t.foreign.map((f) => (
                    <div key={f.currency} className="mt-1 flex flex-wrap items-baseline justify-between gap-x-2">
                      <span className="whitespace-nowrap text-lg font-semibold tabular-nums text-warning">{f.amountMinor > 0 ? formatMoney(f.amountMinor, f.currency) : f.currency}</span>
                      <span className="shrink-0 text-xs text-foreground-muted">{f.count} document{f.count === 1 ? "" : "s"}</span>
                    </div>
                  ))}
                  <p className={small}>
                    recorded as {formatMoney(t.foreign.reduce((n, f) => n + f.recordedMinor, 0), cur)}
                    {t.foreign.some((f) => f.unknownCount > 0) ? ` · ${t.foreign.reduce((n, f) => n + f.unknownCount, 0)} with no amount recorded (${formatMoney(t.foreign.reduce((n, f) => n + f.unknownMinor, 0), cur)})` : ""}
                    {t.foreignTaxMinor > 0 ? ` · ${formatMoney(t.foreignTaxMinor, cur)} VAT still on them` : ""}
                  </p>
                </>
              )}
            </div>,
            <div key={`${cur}-p`} className="rounded-lg border border-border bg-surface p-4" title="What is still owed on these invoices — each counted once, however many of its tax invoices are listed">
              <p className="text-xs text-foreground-muted">Pending</p>
              <p className={`mt-1 text-lg font-semibold tabular-nums ${t.pendingMinor > 0 ? "text-warning" : ""}`}>{formatMoney(t.pendingMinor, cur)}</p>
            </div>,
          ])}
        </div>
      )}

      {/* What the tax invoices in the period come to — the VAT the VAT report counts for them. */}
      {tab !== "all" && <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
      </div>}

      {tab === "all" ? (
        <DataTable
          columns={docColumns}
          data={docs.isLoading ? undefined : docs.data?.rows}
          getRowId={(d) => `${d.kind}-${d.number}-${d.invoiceId}`}
          total={docs.data?.total ?? 0}
          page={page}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={(n) => { setPageSize(n); setPage(1); }}
          isLoading={docs.isLoading}
          isFetching={docs.isPlaceholderData}
          emptyMessage="No tax documents in this period."
        />
      ) : tab === "tis" ? (
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
