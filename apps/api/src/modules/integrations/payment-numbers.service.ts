import { Invoice } from "../invoice/invoice.model";

/*
 * Each invoice's payments with their numbers, for Root (2026-11-25, the Manager TV export: "TI also, as in the
 * report by salesperson") — the CRMs and CS Portal know an invoice, never the tax invoice finance issued for each
 * payment on it. Read-only; void invoices left out. Invoice numbers are per organization, so one number may answer
 * from more than one (Delta International and Delta Banglore each have an IN-00050): each says which. An invoice can also
 * be asked by the CRM's own id for the close (`externalIds`) — a close whose CRM still shows the quote number it had
 * before (QT-00040 is IN-00405 here).
 */
export interface InvoicePaymentNumbers {
  invoiceNumber: string;
  organizationId: string;
  /** The CRM's id for the close (external.externalId), when it came from one. */
  externalId: string;
  payments: { id: string; paidOn: string; amountMinor: number; receiptNumber: string; taxInvoiceNumber: string }[];
}

export async function paymentNumbersFor(invoiceNumbers: string[], externalIds: string[] = []): Promise<InvoicePaymentNumbers[]> {
  const tidy = (l: string[]) => [...new Set(l.map((n) => String(n ?? "").trim()).filter(Boolean))].slice(0, 2000);
  const wanted = tidy(invoiceNumbers), ids = tidy(externalIds);
  if (!wanted.length && !ids.length) return [];
  const rows = await Invoice.find({ $or: [{ invoiceNumber: { $in: wanted } }, { "external.externalId": { $in: ids } }], status: { $ne: "void" } })
    .select("invoiceNumber organizationId external.externalId payments._id payments.paidOn payments.amountMinor payments.receiptNumber payments.taxInvoice.number")
    .lean<any[]>();
  return rows.map((i) => ({
    invoiceNumber: String(i.invoiceNumber),
    organizationId: String(i.organizationId),
    externalId: String(i.external?.externalId ?? ""),
    payments: (i.payments ?? []).map((p: any) => ({
      id: String(p._id),
      paidOn: p.paidOn ? new Date(p.paidOn).toISOString().slice(0, 10) : "",
      amountMinor: Number(p.amountMinor) || 0,
      receiptNumber: String(p.receiptNumber ?? ""),
      taxInvoiceNumber: String(p.taxInvoice?.number ?? ""),
    })),
  }));
}
