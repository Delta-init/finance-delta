/**
 * VAT on payments received (the user, 2026-11-01: "2,000 paid, VAT on the 2,000 — and the next payment gets the VAT
 * on that payment").
 *
 * An enrolment approved part paid, in an organization with Settings → "VAT on payments received" on, is a pro-forma:
 * the invoice still shows the whole course and its balance, but it is not a tax invoice and its VAT is not counted on
 * it. Each payment towards it gets its own tax invoice instead (TI-00001 …), with the VAT inside that payment only —
 * the invoice's own rate, so 2,000 at 5% inclusive carries 95.24 — and the payment that clears it takes whatever VAT
 * is left, so the tax invoices add up to the invoice's VAT to the fil. The VAT report and Revenue's Invoiced view count
 * those tax invoices by the day each was paid.
 *
 * Fully paid at the close, or the setting off, nothing changes: the invoice is the tax invoice, as before. Invoices
 * approved before this never become pro-formas.
 */
import { formatMoney } from "@delta/shared";
import { Organization } from "../organization/organization.model";

type Pay = {
  _id: { toString(): string };
  amountMinor: number;
  paidOn: Date;
  taxInvoice?: { number?: string; netMinor?: number; taxMinor?: number; issuedAt?: Date; emailedAt?: Date } | null;
  toObject?: () => Record<string, unknown>;
};
type Doc = {
  _id: unknown;
  organizationId: unknown;
  invoiceNumber: string;
  totalMinor?: number | null;
  taxTotalMinor?: number | null;
  balanceMinor?: number | null;
  payments: unknown;
  proforma?: { at?: Date } | null;
  enrolment?: { declaredPayments?: { amountMinor: number }[] | null; declaredPaidMinor?: number | null } | null;
  set(path: string, value: unknown): unknown;
  get?(path: string): unknown;
};

/** Settings → "VAT on payments received for part-paid enrolments" — off unless an organization turned it on. */
export async function vatOnPaymentsFor(orgId: unknown): Promise<boolean> {
  const org = await Organization.findById(orgId).select("vatOnPayments").lean<{ vatOnPayments?: boolean }>();
  return org?.vatOnPayments === true;
}

export function isProforma(doc: unknown): boolean {
  return Boolean((doc as Doc).proforma?.at);
}

/**
 * Whether an enrolment being approved starts as a pro-forma: it carries VAT and what was collected at the close is
 * less than the invoice. Decided on what the close declared, not on what approval managed to record — a close paid in
 * full by EMI, which approval leaves for accounts to record, is still paid in full.
 */
export function startsProforma(doc: unknown): boolean {
  const d = doc as Doc;
  if (!d.enrolment || isProforma(d)) return false;
  const total = d.totalMinor ?? 0;
  if (!(total > 0) || !((d.taxTotalMinor ?? 0) > 0)) return false;
  const declared = d.enrolment.declaredPayments?.length
    ? d.enrolment.declaredPayments.reduce((s, p) => s + (p.amountMinor ?? 0), 0)
    : d.enrolment.declaredPaidMinor ?? 0;
  return declared < total;
}

/**
 * Each payment's tax invoice, on the document before it is saved: a number for every payment without one, and the VAT
 * of every one worked out again — its share of the invoice's at the invoice's rate, the payment that clears it taking
 * the rest. Numbers are kept once given. Answers the payments given a number now, to email. Nothing on an invoice that
 * is not a pro-forma.
 */
export async function stampTaxInvoices(doc: unknown): Promise<string[]> {
  const d = doc as Doc;
  if (!isProforma(d)) return [];
  const { nextNumber } = await import("../sequence/sequence.service");
  const payments = (d.payments as Pay[]) ?? [];
  const total = d.totalMinor ?? 0;
  const tax = d.taxTotalMinor ?? 0;
  const cleared = (d.balanceMinor ?? 0) <= 0;
  const share = (amount: number) => (total > 0 ? Math.round((amount * tax) / total) : 0);
  const issued: string[] = [];
  for (let i = 0; i < payments.length; i++) {
    const p = payments[i]!;
    const others = payments.reduce((s, x, j) => (j === i ? s : s + share(x.amountMinor ?? 0)), 0);
    const last = cleared && i === payments.length - 1;
    const taxMinor = Math.max(0, Math.min(p.amountMinor ?? 0, last ? tax - others : share(p.amountMinor ?? 0)));
    const had = p.taxInvoice?.number ? p.taxInvoice : null;
    const number = had?.number ?? await nextNumber(String(d.organizationId), "tax_invoice", "TI-");
    if (!had) issued.push(p._id.toString());
    if (had && had.taxMinor === taxMinor && had.netMinor === (p.amountMinor ?? 0) - taxMinor) continue;
    d.set(`payments.${i}.taxInvoice`, {
      number,
      netMinor: (p.amountMinor ?? 0) - taxMinor,
      taxMinor,
      issuedAt: had?.issuedAt ?? new Date(),
      ...(had?.emailedAt ? { emailedAt: had.emailedAt } : {}),
    });
  }
  return issued;
}

/** A payment about to be taken off a pro-forma: its tax invoice kept on the invoice, cancelled — its number is not reused. */
export function noteCancelledTaxInvoice(doc: unknown, payment: unknown): void {
  const d = doc as Doc;
  const p = payment as Pay;
  if (!isProforma(d) || !p?.taxInvoice?.number) return;
  const list = ((d.get?.("cancelledTaxInvoices") as unknown[] | undefined) ?? []).map((x) =>
    (x as { toObject?: () => unknown }).toObject?.() ?? x);
  d.set("cancelledTaxInvoices", [
    ...list,
    { number: p.taxInvoice.number, amountMinor: p.amountMinor, taxMinor: p.taxInvoice.taxMinor ?? 0, paidOn: p.paidOn, cancelledAt: new Date() },
  ]);
}

/**
 * The client's tax invoice for each payment given one now, by email, the document attached. In the background,
 * never throws; each logged as payment_tax_invoice, and marked emailed once it went.
 */
export async function emailTaxInvoices(orgId: string, invoiceId: unknown, paymentIds: string[]): Promise<void> {
  if (!paymentIds.length) return;
  const { logger } = await import("../../lib/logger");
  try {
    const { Invoice } = await import("./invoice.model");
    const { Customer } = await import("../customer/customer.model");
    const { toDTO } = await import("./invoice.service");
    const { sendNotice } = await import("../../lib/email");
    const { invoicePdfBuffer, invoicePdfName, taxInvoiceView } = await import("@delta/shared");
    const doc = await Invoice.findById(invoiceId).populate("tagIds", "name color");
    if (!doc) return;
    const [customer, org] = await Promise.all([Customer.findById(doc.customerId), Organization.findById(orgId)]);
    const to = String(customer?.email ?? "").trim();
    const dto = toDTO(doc);
    const cur = dto.currency;
    for (const pid of paymentIds) {
      const payment = dto.payments.find((p) => p.id === pid);
      if (!payment?.taxInvoice) continue;
      const ti = payment.taxInvoice;
      const view = taxInvoiceView(dto, payment);
      const log = { organizationId: orgId, kind: "payment_tax_invoice", ref: { type: "invoice", id: String(doc._id), label: ti.number } };
      const result = await sendNotice({
        to: [to],
        subject: `Tax invoice ${ti.number} — ${formatMoney(payment.amountMinor, cur)} received`,
        title: "Thank you — we have received your payment",
        lines: [
          `Dear ${dto.customerName || "client"}, this is the tax invoice for your payment towards invoice ${dto.invoiceNumber}.`,
          `Tax invoice ${ti.number} · ${formatMoney(payment.amountMinor, cur)} paid on ${payment.paidOn} · ${formatMoney(ti.netMinor, cur)} + ${formatMoney(ti.taxMinor, cur)} VAT`,
          `Invoice ${dto.invoiceNumber}: ${formatMoney(dto.totalMinor, cur)} in all, ${formatMoney(dto.amountPaidMinor, cur)} paid, ${formatMoney(dto.balanceMinor, cur)} left to pay.`,
          org?.name ?? "",
        ].filter(Boolean),
        attachments: [{
          filename: invoicePdfName(ti.number),
          content: invoicePdfBuffer({ invoice: view, taxInvoiceAgainst: dto.invoiceNumber, org: org as never, customer: customer as never }),
          contentType: "application/pdf",
        }],
        log,
      });
      if (result.sent > 0) {
        await Invoice.updateOne({ _id: doc._id, "payments._id": pid }, { $set: { "payments.$.taxInvoice.emailedAt": new Date() } });
      }
    }
  } catch (err) {
    logger.error({ err, invoiceId: String(invoiceId) }, "Could not email the payment tax invoices");
  }
}
