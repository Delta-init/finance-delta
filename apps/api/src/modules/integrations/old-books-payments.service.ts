import { Invoice } from "../invoice/invoice.model";
import { User } from "../user/user.model";

/*
 * Old-books money for the sales CRMs and Root (the user, 2026-11-25: "why the old books is not showing in the sales
 * CRM and Manager TV" → counted for the salesperson, commission too, in all the CRMs and Root).
 *
 * The old books are the invoices imported from the previous system (external.source "old_books"): sales from before
 * the CRMs, still paid off in instalments, which no CRM lead points at — so no CRM ever counted them. Each one comes
 * here with its salesperson's email (how a CRM finds its own user), its course line, its fee and every payment, for
 * any invoice with a payment on or after `from`. Read-only. A void one comes too, with its status, so a CRM takes back
 * what it counted on it.
 */

export interface OldBooksPayment { id: string; paidOn: string; amountMinor: number; method: string }
export interface OldBooksInvoice {
  invoiceId: string;
  invoiceNumber: string;
  organizationId: string;
  customerName: string;
  salespersonName: string;
  /** The salesperson's login email in finance, lower-case; "" when the invoice has none. */
  salespersonEmail: string;
  /** The course as the old books name it (its first line). */
  course: string;
  currency: string;
  issueDate: string;
  totalMinor: number;
  balanceMinor: number;
  status: string;
  /** Every payment on it, oldest first — the earlier ones too, so a CRM can tell when it was paid in full. */
  payments: OldBooksPayment[];
}

export const OLD_BOOKS_SOURCE = "old_books";
const day = (d: unknown) => (d ? new Date(d as string).toISOString().slice(0, 10) : "");

export async function oldBooksPaymentsSince(from: string): Promise<OldBooksInvoice[]> {
  const since = new Date(`${from}T00:00:00.000Z`);
  const invoices = await Invoice.find({ "external.source": OLD_BOOKS_SOURCE, "payments.paidOn": { $gte: since } })
    .select("organizationId invoiceNumber customerName salespersonId salespersonName lineItems currency issueDate totalMinor balanceMinor status payments")
    .lean<any[]>();
  const users = await User.find({ _id: { $in: invoices.map((i) => i.salespersonId).filter(Boolean) } }).select("email").lean<{ _id: unknown; email?: string }[]>();
  const emailOf = new Map(users.map((u) => [String(u._id), String(u.email ?? "").trim().toLowerCase()]));
  return invoices.map((i) => ({
    invoiceId: String(i._id),
    invoiceNumber: String(i.invoiceNumber ?? ""),
    organizationId: String(i.organizationId),
    customerName: String(i.customerName ?? ""),
    salespersonName: String(i.salespersonName ?? "").replace(/\s+/g, " ").trim(),
    salespersonEmail: emailOf.get(String(i.salespersonId)) ?? "",
    course: String(i.lineItems?.[0]?.description ?? ""),
    currency: String(i.currency ?? "AED"),
    issueDate: day(i.issueDate),
    totalMinor: Number(i.totalMinor) || 0,
    balanceMinor: Number(i.balanceMinor) || 0,
    status: String(i.status ?? ""),
    payments: (i.payments ?? [])
      .filter((p: any) => (Number(p.amountMinor) || 0) > 0 && p.paidOn)
      .map((p: any) => ({ id: String(p._id), paidOn: day(p.paidOn), amountMinor: Number(p.amountMinor) || 0, method: String(p.method ?? "") }))
      .sort((a: OldBooksPayment, b: OldBooksPayment) => a.paidOn.localeCompare(b.paidOn)),
  })).sort((a, b) => a.invoiceNumber.localeCompare(b.invoiceNumber));
}
