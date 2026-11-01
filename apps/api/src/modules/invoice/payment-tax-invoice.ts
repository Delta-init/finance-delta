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
  const taxes = taxShares(d);
  const issued: string[] = [];
  for (let i = 0; i < payments.length; i++) {
    const p = payments[i]!;
    const taxMinor = taxes[i]!;
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

/**
 * The VAT in each payment on a pro-forma, in the order they are on it: its share of the invoice's VAT at the
 * invoice's rate — the payment that clears the invoice taking whatever is left, so they add up to it exactly.
 */
export function taxShares(doc: unknown): number[] {
  const d = doc as Doc;
  const payments = (d.payments as Pay[]) ?? [];
  const total = d.totalMinor ?? 0;
  const tax = d.taxTotalMinor ?? 0;
  const cleared = (d.balanceMinor ?? 0) <= 0;
  const share = (amount: number) => (total > 0 ? Math.round((amount * tax) / total) : 0);
  return payments.map((p, i) => {
    const others = payments.reduce((s, x, j) => (j === i ? s : s + share(x.amountMinor ?? 0)), 0);
    const last = cleared && i === payments.length - 1;
    return Math.max(0, Math.min(p.amountMinor ?? 0, last ? tax - others : share(p.amountMinor ?? 0)));
  });
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

export interface ProformaRow {
  id: string; invoiceNumber: string; customerId: string; customerName: string; course: string; salespersonName: string;
  issueDate: string; currency: string; totalMinor: number; taxTotalMinor: number; amountPaidMinor: number; balanceMinor: number;
  status: string; taxInvoices: string[]; proformaAt: string;
}
export interface TaxInvoiceRow {
  number: string; invoiceId: string; invoiceNumber: string; paymentId: string; customerId: string; customerName: string;
  paidOn: string; currency: string; amountMinor: number; netMinor: number; taxMinor: number; method: string;
  emailed: boolean; cancelled: boolean;
}

/**
 * Sales → Pro-formas & tax invoices (the user, 2026-11-01): every pro-forma — issued in the period, or paid on in it —
 * and every payment's tax invoice dated in it (its paid day), the cancelled ones too, flagged. The VAT figure is the
 * tax invoices', not cancelled — the same the VAT report counts. A word in `q` matches a number or the client.
 */
export async function listProformasAndTaxInvoices(
  orgId: string,
  opts: { from?: string; to?: string; q?: string } = {},
): Promise<{ proformas: ProformaRow[]; taxInvoices: TaxInvoiceRow[]; totals: Record<string, { count: number; amountMinor: number; netMinor: number; taxMinor: number }> }> {
  const { Invoice } = await import("./invoice.model");
  const { Types } = await import("mongoose");
  const day = (d: unknown) => new Date(d as Date).toISOString().slice(0, 10);
  const lo = opts.from ? new Date(`${opts.from}T00:00:00.000Z`) : null;
  const hi = opts.to ? new Date(`${opts.to}T23:59:59.999Z`) : null;
  const inRange = (d: unknown) => { const t = new Date(d as Date).getTime(); return (!lo || t >= lo.getTime()) && (!hi || t <= hi.getTime()); };
  const range = { ...(lo ? { $gte: lo } : {}), ...(hi ? { $lte: hi } : {}) };
  const ranged = Boolean(lo || hi);
  const q = (opts.q ?? "").trim();
  const like = q ? new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : null;

  const docs = await Invoice.find({
    organizationId: new Types.ObjectId(orgId),
    "proforma.at": { $exists: true },
    status: { $ne: "void" },
    ...(ranged ? { $or: [{ issueDate: range }, { "payments.paidOn": range }, { "cancelledTaxInvoices.paidOn": range }] } : {}),
  }).select("invoiceNumber customerId customerName salespersonName enrolment.course lineItems.description issueDate currency totalMinor taxTotalMinor amountPaidMinor balanceMinor status proforma payments cancelledTaxInvoices")
    .sort({ issueDate: -1, invoiceNumber: -1 }).lean<any[]>();

  const proformas: ProformaRow[] = [];
  const taxInvoices: TaxInvoiceRow[] = [];
  for (const d of docs) {
    const base = { invoiceId: String(d._id), invoiceNumber: String(d.invoiceNumber), customerId: String(d.customerId ?? ""), customerName: String(d.customerName ?? ""), currency: String(d.currency ?? "AED") };
    const matches = (...xs: string[]) => !like || [base.invoiceNumber, base.customerName, ...xs].some((x) => like.test(x));
    const tis: TaxInvoiceRow[] = [];
    for (const p of d.payments ?? []) {
      if (!p.taxInvoice?.number) continue;
      tis.push({
        ...base, number: p.taxInvoice.number, paymentId: String(p._id), paidOn: day(p.paidOn), amountMinor: p.amountMinor ?? 0,
        netMinor: p.taxInvoice.netMinor ?? 0, taxMinor: p.taxInvoice.taxMinor ?? 0, method: String(p.method ?? ""),
        emailed: Boolean(p.taxInvoice.emailedAt), cancelled: false,
      });
    }
    for (const c of d.cancelledTaxInvoices ?? []) {
      tis.push({
        ...base, number: c.number, paymentId: "", paidOn: day(c.paidOn), amountMinor: c.amountMinor ?? 0,
        netMinor: (c.amountMinor ?? 0) - (c.taxMinor ?? 0), taxMinor: c.taxMinor ?? 0, method: "", emailed: false, cancelled: true,
      });
    }
    const course = String(d.enrolment?.course || d.lineItems?.[0]?.description || "");
    if ((!ranged || inRange(d.issueDate) || tis.some((t) => inRange(t.paidOn))) && matches(course, ...tis.map((t) => t.number))) {
      proformas.push({
        id: base.invoiceId, invoiceNumber: base.invoiceNumber, customerId: base.customerId, customerName: base.customerName, course,
        salespersonName: String(d.salespersonName ?? ""), issueDate: day(d.issueDate), currency: base.currency,
        totalMinor: d.totalMinor ?? 0, taxTotalMinor: d.taxTotalMinor ?? 0, amountPaidMinor: d.amountPaidMinor ?? 0, balanceMinor: d.balanceMinor ?? 0,
        status: String(d.status ?? ""), taxInvoices: tis.filter((t) => !t.cancelled).map((t) => t.number), proformaAt: new Date(d.proforma.at).toISOString(),
      });
    }
    for (const t of tis) if ((!ranged || inRange(t.paidOn)) && matches(t.number)) taxInvoices.push(t);
  }
  taxInvoices.sort((a, b) => (b.paidOn.localeCompare(a.paidOn)) || b.number.localeCompare(a.number));

  const totals: Record<string, { count: number; amountMinor: number; netMinor: number; taxMinor: number }> = {};
  for (const t of taxInvoices) {
    if (t.cancelled) continue;
    const x = (totals[t.currency] ??= { count: 0, amountMinor: 0, netMinor: 0, taxMinor: 0 });
    x.count++; x.amountMinor += t.amountMinor; x.netMinor += t.netMinor; x.taxMinor += t.taxMinor;
  }
  return { proformas, taxInvoices, totals };
}
