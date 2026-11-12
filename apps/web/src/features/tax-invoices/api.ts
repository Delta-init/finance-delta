"use client";

import { useQuery } from "@tanstack/react-query";
import { api, type PageMeta } from "@/lib/api";

/** A pro-forma (VAT on payments received): the enrolment's invoice, not itself a tax invoice. */
export interface ProformaRow {
  id: string; invoiceNumber: string; customerId: string; customerName: string; course: string; salespersonName: string;
  issueDate: string; currency: string; totalMinor: number; taxTotalMinor: number; amountPaidMinor: number; balanceMinor: number;
  status: string; taxInvoices: string[]; proformaAt: string;
}

/** One payment's tax invoice (TI-…) — or one cancelled, its payment since deleted. */
export interface TaxInvoiceRow {
  number: string; invoiceId: string; invoiceNumber: string; paymentId: string; customerId: string; customerName: string;
  paidOn: string; currency: string; amountMinor: number; netMinor: number; taxMinor: number; method: string;
  emailed: boolean; cancelled: boolean;
}

export interface TaxInvoicesAnswer {
  proformas: ProformaRow[];
  taxInvoices: TaxInvoiceRow[];
  totals: Record<string, { count: number; amountMinor: number; netMinor: number; taxMinor: number }>;
}

export function taxInvoicesPath(params: { from?: string; to?: string; q?: string }) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v).map(([k, v]) => [k, String(v)])).toString();
  return `invoices/tax-invoices${qs ? `?${qs}` : ""}`;
}

export function useTaxInvoices(params: { from?: string; to?: string; q?: string }) {
  return useQuery({
    queryKey: ["invoices", "tax-invoices", params],
    queryFn: () => api.get<TaxInvoicesAnswer>(taxInvoicesPath(params)),
    placeholderData: (prev) => prev,
  });
}

/** One tax document: an invoice (IN-…), or one payment's tax invoice (TI-…) against its pro-forma. */
export interface TaxDocumentRow {
  kind: "invoice" | "ti";
  number: string;
  /** The invoice's date, or the day the payment was paid — the day the VAT report counts it on. */
  date: string;
  /** The invoice itself; for a TI, the pro-forma it is against. */
  invoiceId: string; invoiceNumber: string;
  paymentId: string; method: string;
  customerId: string; customerName: string; currency: string;
  netMinor: number; taxMinor: number; amountMinor: number;
  /** Of that invoice (for a TI, of its pro-forma): the whole fee, what is paid of it, what is still owed. */
  feeMinor: number; paidMinor: number; balanceMinor: number;
  /**
   * Paid in rupees (2026-11-13): how much of this document's amount was, as recorded in the invoice's currency (0 when
   * none), the rupees themselves in paise (0 when they were not recorded), and the VAT still carried on that part.
   */
  inrAedMinor: number; inrMinor: number; inrTaxMinor: number;
  /** The same for everything paid on the invoice so far, and how much of it has its rupees recorded. */
  invInrAedMinor: number; invInrMinor: number; invInrKnownAedMinor: number;
}
export interface TaxDocumentTotals {
  count: number; netMinor: number; taxMinor: number; amountMinor: number; pendingMinor: number;
  /** The documents paid in rupees: how many, the rupees (paise), what they were recorded as, the VAT on them. */
  inrCount: number; inrMinor: number; inrAedMinor: number; inrTaxMinor: number;
}
// A type, not an interface: it goes to the API as query parameters, which want an index signature.
export type TaxDocumentParams = { from?: string; to?: string; q?: string; type?: "invoice" | "ti"; pending?: "yes"; paidIn?: "aed" | "inr" };

/** All tax documents (2026-11-12): invoices and payment tax invoices in one list, a page at a time from the server. */
export function useTaxDocuments(params: TaxDocumentParams & { page: number; pageSize: number }) {
  return useQuery({
    queryKey: ["invoices", "tax-documents", params],
    queryFn: async () => {
      const { data, meta } = await api.getList<TaxDocumentRow>("invoices/tax-documents", params);
      return { rows: data, total: meta.total, totals: (meta as PageMeta & { totals?: Record<string, TaxDocumentTotals> }).totals ?? {} };
    },
    placeholderData: (prev) => prev,
  });
}

