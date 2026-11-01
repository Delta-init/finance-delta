"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

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
