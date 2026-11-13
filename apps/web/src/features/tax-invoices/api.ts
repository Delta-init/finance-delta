"use client";

import { useQuery } from "@tanstack/react-query";
import type { PaidInCurrency } from "@delta/shared";
import { api, type PageMeta } from "@/lib/api";

/** A pro-forma (VAT on payments received): the enrolment's invoice, not itself a tax invoice. */
export interface ProformaRow {
  id: string; invoiceNumber: string; customerId: string; customerName: string; course: string; salespersonName: string;
  issueDate: string; currency: string; totalMinor: number; taxTotalMinor: number; amountPaidMinor: number; balanceMinor: number;
  status: string; taxInvoices: string[]; proformaAt: string;
  /** Of what is paid, what was paid in other currencies — a line each — and what all of that was recorded as (2026-11-13). */
  foreign?: PaidInCurrency[]; foreignRecordedMinor?: number;
}

/** One payment's tax invoice (TI-…) — or one cancelled, its payment since deleted. */
export interface TaxInvoiceRow {
  number: string; invoiceId: string; invoiceNumber: string; paymentId: string; customerId: string; customerName: string;
  paidOn: string; currency: string; amountMinor: number; netMinor: number; taxMinor: number; method: string;
  emailed: boolean; cancelled: boolean;
  /** The currency it was paid in when not the invoice's ("" when it was), and the amount in it (0 when never recorded). */
  paidCurrency?: string; paidAmountMinor?: number;
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
   * Paid in another currency (2026-11-13: "whichever currency they are giving … no need to convert anywhere"): the
   * part(s) of this document's amount that were — a line per currency, with the amount in it (0 when never recorded)
   * and what it was recorded as — what all of that was recorded as, and the VAT still carried on it.
   */
  foreign: PaidInCurrency[]; foreignRecordedMinor: number; foreignTaxMinor: number;
  /** The same for everything paid on the invoice so far, and how much of it has its amount recorded. */
  invForeign: PaidInCurrency[]; invForeignRecordedMinor: number; invForeignKnownMinor: number;
}
export interface TaxDocumentTotals {
  count: number; netMinor: number; taxMinor: number; amountMinor: number; pendingMinor: number;
  /** What of these documents was paid in other currencies, as recorded in this one, and the VAT still on that part. */
  foreignRecordedMinor: number; foreignTaxMinor: number;
  /** …a line for each such currency; then those whose amount was never recorded (not in the amounts). */
  foreign: Array<{ currency: string; count: number; amountMinor: number; recordedMinor: number; taxMinor: number; unknownCount: number; unknownMinor: number }>;
}
// A type, not an interface: it goes to the API as query parameters, which want an index signature.
export type TaxDocumentParams = { from?: string; to?: string; q?: string; type?: "invoice" | "ti"; pending?: "yes"; paidIn?: string };

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

