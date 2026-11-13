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
 *
 * Only payments in the invoice's own currency carry VAT (the user, 2026-11-13: first "INR payment doesn't have the
 * VAT", then "only AED payments carry VAT"). A payment made in another currency — typed so where it was taken (a CRM
 * close's currency and rate, rupees in CS Portal) or by INR Transfer — is marked `vatFree` as it is recorded
 * (@delta/shared isVatFreePayment; never on an invoice itself in rupees, which is taxed as it always was): on a
 * pro-forma its tax invoice keeps its number and carries no VAT, and the other payments carry the VAT of their own
 * amounts only. An enrolment paid in full at the close, all of it in other currencies, has the VAT taken off its
 * invoice (stripVatForOtherCurrency); paid in full partly so, it is a pro-forma so that each payment has its own
 * document. The client pays the same; nothing is taken out for VAT. A payment recorded before this is as it was until
 * scripts/inr-payments-no-vat.ts corrects it.
 */
import { computeInvoiceLine, formatMoney, isRupeePayment, isVatFreePayment, paidAmountMinor, paidCurrency, paidInOtherCurrencies, RUPEE_METHOD, sumInvoiceTotals, type PaidInCurrency } from "@delta/shared";
import { Organization } from "../organization/organization.model";

type Pay = {
  _id: { toString(): string };
  amountMinor: number;
  paidOn: Date;
  method?: string;
  original?: { currency?: string; amountMinor?: number; rate?: number } | null;
  vatFree?: boolean | null;
  taxInvoice?: { number?: string; netMinor?: number; taxMinor?: number; issuedAt?: Date; emailedAt?: Date } | null;
  toObject?: () => Record<string, unknown>;
};
type Doc = {
  _id: unknown;
  organizationId: unknown;
  invoiceNumber: string;
  currency?: string | null;
  taxInclusive?: boolean | null;
  lineItems?: unknown;
  roundOffMinor?: number | null;
  totalMinor?: number | null;
  taxTotalMinor?: number | null;
  balanceMinor?: number | null;
  payments: unknown;
  proforma?: { at?: Date } | null;
  enrolment?: {
    declaredPayments?: { amountMinor: number; method?: string; original?: { currency?: string; amountMinor?: number } | null }[] | null;
    declaredPaidMinor?: number | null;
  } | null;
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

// What a payment in another currency is, and its amount: @delta/shared (the web shows them by the same rule).
export { isRupeePayment, isVatFreePayment, RUPEE_METHOD };

// The same, as aggregation expressions over a payment `p` of the invoice in hand.
const upperOf = (path: string) => ({ $toUpper: { $ifNull: [path, ""] } });
const ownCurrencyExpr = { $cond: [{ $eq: [upperOf("$currency"), ""] }, "AED", upperOf("$currency")] };
/** paidCurrency: the currency it was made in when not the invoice's — "" when it was. */
const paidCurrencyExpr = (p: string) => ({
  $switch: {
    branches: [
      { case: { $and: [{ $ne: [upperOf(`${p}.original.currency`), ""] }, { $ne: [upperOf(`${p}.original.currency`), ownCurrencyExpr] }] }, then: upperOf(`${p}.original.currency`) },
      { case: { $and: [{ $eq: [`${p}.method`, RUPEE_METHOD] }, { $ne: [ownCurrencyExpr, "INR"] }] }, then: "INR" },
    ],
    default: "",
  },
});
/** paidAmountMinor, for the currency `cur` it was made in: 0 when the amount was never recorded. */
const paidAmountExpr = (p: string, cur: unknown) => ({ $cond: [
  { $and: [{ $eq: [upperOf(`${p}.original.currency`), cur] }, { $gt: [`${p}.original.amountMinor`, 0] }] }, `${p}.original.amountMinor`,
  { $cond: [{ $and: [{ $eq: [upperOf(`${p}.bankCurrency`), cur] }, { $gt: [`${p}.bankAmountMinor`, 0] }] }, `${p}.bankAmountMinor`, 0] },
] });
/**
 * An aggregation stage over invoices: `foreignPayments` — each payment made in a currency other than the invoice's:
 * that currency (`cur`), what it was recorded as in the invoice's (`aed`) and the amount in its own, in minor units
 * (`amt`, 0 when it was never recorded).
 */
export const foreignPaymentsStage = {
  $addFields: {
    foreignPayments: {
      $filter: {
        input: {
          $map: {
            input: { $ifNull: ["$payments", []] }, as: "p",
            in: { $let: { vars: { cur: paidCurrencyExpr("$$p") }, in: { cur: "$$cur", aed: { $ifNull: ["$$p.amountMinor", 0] }, amt: paidAmountExpr("$$p", "$$cur") } } },
          },
        },
        as: "f", cond: { $ne: ["$$f.cur", ""] },
      },
    },
  },
};
/** `foreignPayments` added up by currency: [{ cur, amt, aed, known }] — `known` what the payments with an amount were recorded as. */
const foreignByCurrencyExpr = {
  $map: {
    input: { $setUnion: ["$foreignPayments.cur", []] }, as: "c",
    in: {
      cur: "$$c",
      amt: { $sum: { $map: { input: "$foreignPayments", as: "f", in: { $cond: [{ $eq: ["$$f.cur", "$$c"] }, "$$f.amt", 0] } } } },
      aed: { $sum: { $map: { input: "$foreignPayments", as: "f", in: { $cond: [{ $eq: ["$$f.cur", "$$c"] }, "$$f.aed", 0] } } } },
      known: { $sum: { $map: { input: "$foreignPayments", as: "f", in: { $cond: [{ $and: [{ $eq: ["$$f.cur", "$$c"] }, { $gt: ["$$f.amt", 0] }] }, "$$f.aed", 0] } } } },
    },
  },
};

/** What the close declared, and how much of it in currencies that carry no VAT. */
function declaredAtClose(d: Doc): { declared: number; free: number } {
  const list = d.enrolment?.declaredPayments ?? [];
  if (!list.length) return { declared: d.enrolment?.declaredPaidMinor ?? 0, free: 0 };
  return {
    declared: list.reduce((s, p) => s + (p.amountMinor ?? 0), 0),
    free: list.reduce((s, p) => s + (isVatFreePayment(p, d.currency) ? p.amountMinor ?? 0 : 0), 0),
  };
}

/** An enrolment being approved that was paid in full at the close, every payment in another currency: its invoice carries no VAT. */
export function closePaidInOtherCurrency(doc: unknown): boolean {
  const d = doc as Doc;
  if (!d.enrolment || isProforma(d)) return false;
  const total = d.totalMinor ?? 0;
  const { declared, free } = declaredAtClose(d);
  return total > 0 && (d.taxTotalMinor ?? 0) > 0 && declared >= total && free === declared;
}

/**
 * The VAT taken off an invoice paid in another currency, on the document before it is saved: every line untaxed, the
 * total as it was — the prices are tax-inclusive, so the client's figure does not move. What it carried is kept on
 * `rupeesNoVat` (named for its first case, rupees). Not on one priced before tax (taking the tax off would lower
 * what the client was asked for) — answers false, and the invoice is left as it is.
 */
export function stripVatForOtherCurrency(doc: unknown): boolean {
  const d = doc as Doc;
  const tax = d.taxTotalMinor ?? 0;
  if (!(tax > 0) || d.taxInclusive !== true) return false;
  const lines = ((d.lineItems as unknown[]) ?? []).map((l) => ((l as { toObject?: () => Record<string, any> }).toObject?.() ?? l) as Record<string, any>);
  if (!lines.length) return false;
  const inputs = lines.map((l) => ({ quantity: l.quantity ?? 1, unitPriceMinor: l.unitPriceMinor ?? 0, discountPct: l.discountPct ?? 0, taxes: [], taxInclusive: true }));
  const summed = sumInvoiceTotals(inputs);
  const roundOff = d.roundOffMinor ?? 0;
  if (summed.totalMinor + roundOff !== (d.totalMinor ?? 0)) return false;
  d.set("rupeesNoVat", { at: new Date(), taxMinor: tax, lineTaxes: lines.map((l) => l.taxes ?? []) });
  d.set("lineItems", lines.map((l, i) => {
    const b = computeInvoiceLine(inputs[i]!);
    return { ...l, taxes: [], lineSubtotalMinor: b.lineSubtotalMinor, discountMinor: b.discountMinor, taxableMinor: b.taxableMinor, taxTotalMinor: 0, lineTotalMinor: b.lineTotalMinor };
  }));
  d.set("subtotalMinor", summed.subtotalMinor);
  d.set("discountTotalMinor", summed.discountTotalMinor);
  d.set("taxBreakdown", []);
  d.set("taxTotalMinor", 0);
  return true;
}

/**
 * Whether an enrolment being approved starts as a pro-forma: it carries VAT and what was collected at the close is
 * less than the invoice. Decided on what the close declared, not on what approval managed to record — a close paid in
 * full by EMI, which approval leaves for accounts to record, is still paid in full.
 *
 * Also one paid in full with part of it in another currency (2026-11-13): that part carries no VAT and the rest
 * does, which one invoice cannot say — so each payment gets its own document. (All of it: closePaidInOtherCurrency.)
 */
export function startsProforma(doc: unknown): boolean {
  const d = doc as Doc;
  if (!d.enrolment || isProforma(d)) return false;
  const total = d.totalMinor ?? 0;
  if (!(total > 0) || !((d.taxTotalMinor ?? 0) > 0)) return false;
  const { declared, free } = declaredAtClose(d);
  return declared < total || (free > 0 && free < declared);
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
 *
 * A payment marked `vatFree` (made in another currency) carries none. With one on it, the others still carry the VAT of
 * their own amounts — the last of them, once the invoice is cleared, taking what is left of the VAT on what was not
 * paid in another currency, never that part's share.
 */
export function taxShares(doc: unknown): number[] {
  const d = doc as Doc;
  const payments = (d.payments as Pay[]) ?? [];
  const total = d.totalMinor ?? 0;
  const tax = d.taxTotalMinor ?? 0;
  const cleared = (d.balanceMinor ?? 0) <= 0;
  const share = (amount: number) => (total > 0 ? Math.round((amount * tax) / total) : 0);
  const free = payments.map((p) => p.vatFree === true);
  const taxedSum = payments.reduce((s, p, i) => (free[i] ? s : s + (p.amountMinor ?? 0)), 0);
  const target = free.some(Boolean) ? share(taxedSum) : tax;
  const lastTaxed = free.lastIndexOf(false);
  return payments.map((p, i) => {
    if (free[i]) return 0;
    const others = payments.reduce((s, x, j) => (j === i || free[j] ? s : s + share(x.amountMinor ?? 0)), 0);
    const last = cleared && i === lastTaxed;
    return Math.max(0, Math.min(p.amountMinor ?? 0, last ? target - others : share(p.amountMinor ?? 0)));
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
  /** Of what is paid, what was paid in other currencies — a line each — and what all of that was recorded as (2026-11-13). */
  foreign: PaidInCurrency[]; foreignRecordedMinor: number;
}
export interface TaxInvoiceRow {
  number: string; invoiceId: string; invoiceNumber: string; paymentId: string; customerId: string; customerName: string;
  paidOn: string; currency: string; amountMinor: number; netMinor: number; taxMinor: number; method: string;
  emailed: boolean; cancelled: boolean;
  /** The currency it was paid in when not the invoice's ("" when it was), and the amount in it (0 when never recorded). */
  paidCurrency: string; paidAmountMinor: number;
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
        paidCurrency: paidCurrency(p, base.currency) ?? "", paidAmountMinor: paidAmountMinor(p, base.currency),
      });
    }
    for (const c of d.cancelledTaxInvoices ?? []) {
      tis.push({
        ...base, number: c.number, paymentId: "", paidOn: day(c.paidOn), amountMinor: c.amountMinor ?? 0,
        netMinor: (c.amountMinor ?? 0) - (c.taxMinor ?? 0), taxMinor: c.taxMinor ?? 0, method: "", emailed: false, cancelled: true,
        paidCurrency: "", paidAmountMinor: 0,
      });
    }
    const course = String(d.enrolment?.course || d.lineItems?.[0]?.description || "");
    if ((!ranged || inRange(d.issueDate) || tis.some((t) => inRange(t.paidOn))) && matches(course, ...tis.map((t) => t.number))) {
      proformas.push({
        id: base.invoiceId, invoiceNumber: base.invoiceNumber, customerId: base.customerId, customerName: base.customerName, course,
        salespersonName: String(d.salespersonName ?? ""), issueDate: day(d.issueDate), currency: base.currency,
        totalMinor: d.totalMinor ?? 0, taxTotalMinor: d.taxTotalMinor ?? 0, amountPaidMinor: d.amountPaidMinor ?? 0, balanceMinor: d.balanceMinor ?? 0,
        status: String(d.status ?? ""), taxInvoices: tis.filter((t) => !t.cancelled).map((t) => t.number), proformaAt: new Date(d.proforma.at).toISOString(),
        foreign: paidInOtherCurrencies(d.payments, base.currency).lines, foreignRecordedMinor: paidInOtherCurrencies(d.payments, base.currency).recordedMinor,
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

/** One tax document: an invoice (IN-…), or one payment's tax invoice (TI-…) against its pro-forma. */
export interface TaxDocumentRow {
  kind: "invoice" | "ti";
  number: string;
  /** The day the VAT report counts it on: the invoice's date, or the day the payment was paid. */
  date: string;
  /** The invoice itself — for a TI, the pro-forma it is against. */
  invoiceId: string; invoiceNumber: string;
  /** A TI's payment; "" for an invoice. */
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
  /**
   * …and a line for each such currency: how many documents, the amount in it, what that was recorded as and the VAT
   * on it — then those whose amount was never recorded (they are not in `amountMinor` / `recordedMinor`).
   */
  foreign: Array<{ currency: string; count: number; amountMinor: number; recordedMinor: number; taxMinor: number; unknownCount: number; unknownMinor: number }>;
}

/**
 * Sales → Pro-formas & tax invoices → All tax documents (the user, 2026-11-12: every tax document in one place, with
 * what is paid and what is pending). Exactly what the VAT report's output VAT counts (reports.service outputTax): each
 * invoice that is not a draft, void or a pro-forma, on its date; and for a pro-forma, each payment's tax invoice on the
 * day paid — a cancelled one is no longer a tax document and is left out. So the VAT here is the VAT report's for the
 * same days. A TI's paid / pending are its pro-forma's, and `pendingMinor` counts each invoice once however many of
 * its tax invoices are listed. One page at a time: the invoices run to thousands.
 *
 * What was paid in another currency is told apart (2026-11-13): each row says how much of it was and in what, with
 * the amount as it was paid when that was recorded; the totals count each currency on its own; and `paidIn` keeps
 * the documents paid in the invoice's own currency ("own"), in any other ("other"), or in one (its code).
 */
export async function listTaxDocuments(
  orgId: string,
  opts: { from?: string; to?: string; q?: string; type?: "invoice" | "ti"; pending?: boolean; paidIn?: string; page?: number; pageSize?: number } = {},
): Promise<{ rows: TaxDocumentRow[]; total: number; page: number; pageSize: number; totals: Record<string, TaxDocumentTotals> }> {
  const { Invoice } = await import("./invoice.model");
  const { Types } = await import("mongoose");
  const day = (d: unknown) => new Date(d as Date).toISOString().slice(0, 10);
  const lo = opts.from ? new Date(`${opts.from}T00:00:00.000Z`) : null;
  const hi = opts.to ? new Date(`${opts.to}T23:59:59.999Z`) : null;
  const range = { ...(lo ? { $gte: lo } : {}), ...(hi ? { $lte: hi } : {}) };
  const ranged = Boolean(lo || hi);
  const q = (opts.q ?? "").trim();
  const like = q ? new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : null;
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(opts.pageSize ?? 25)));

  const fee = { $ifNull: ["$totalMinor", 0] };
  const half = (x: unknown) => ({ $floor: { $add: [x, 0.5] } });
  const paidIn = (opts.paidIn ?? "").trim().toLowerCase();
  // "aed" and "inr" are how the filter was first sent (188314c).
  const paidInMatch = !paidIn ? null
    : paidIn === "own" || paidIn === "aed" ? { "doc.foreignRecordedMinor": { $lte: 0 } }
      : paidIn === "other" ? { "doc.foreignRecordedMinor": { $gt: 0 } }
        : { "doc.parts.cur": paidIn.toUpperCase() };

  // An aggregation is not cast by the schema: ids and dates go in as what they are.
  const invoices = { "proforma.at": { $exists: false }, ...(ranged ? { issueDate: range } : {}) };
  const proformas = { "proforma.at": { $exists: true }, payments: { $elemMatch: { "taxInvoice.number": { $exists: true }, ...(ranged ? { paidOn: range } : {}) } } };
  const [out] = await Invoice.aggregate<{
    rows: any[];
    totals: Array<{ _id: string; count: number; netMinor: number; taxMinor: number; amountMinor: number; foreignRecordedMinor: number; foreignTaxMinor: number }>;
    foreign: Array<{ _id: { c: string; f: string }; count: number; amountMinor: number; recordedMinor: number; taxMinor: number; unknownCount: number; unknownMinor: number }>;
    pending: Array<{ _id: string; pendingMinor: number }>;
  }>([
    {
      $match: {
        organizationId: new Types.ObjectId(orgId),
        status: { $nin: ["draft", "void"] },
        ...(opts.type === "invoice" ? invoices : opts.type === "ti" ? proformas : { $or: [invoices, proformas] }),
        ...(opts.pending ? { balanceMinor: { $gt: 0 } } : {}),
      },
    },
    // What was paid on the invoice in other currencies: each such payment, then a line per currency.
    foreignPaymentsStage,
    {
      $addFields: {
        invForeign: foreignByCurrencyExpr,
        invForeignRecordedMinor: { $sum: "$foreignPayments.aed" },
        invForeignKnownMinor: { $sum: { $map: { input: "$foreignPayments", as: "f", in: { $cond: [{ $gt: ["$$f.amt", 0] }, "$$f.aed", 0] } } } },
      },
    },
    {
      $project: {
        invoiceNumber: 1, customerId: 1, customerName: 1, currency: 1, totalMinor: 1, amountPaidMinor: 1, balanceMinor: 1,
        invForeign: 1, invForeignRecordedMinor: 1, invForeignKnownMinor: 1,
        doc: {
          $cond: [
            { $gt: ["$proforma.at", null] },
            {
              $map: {
                input: { $filter: { input: { $ifNull: ["$payments", []] }, as: "p", cond: { $gt: ["$$p.taxInvoice.number", null] } } },
                as: "p",
                in: {
                  kind: "ti", number: "$$p.taxInvoice.number", date: "$$p.paidOn", paymentId: "$$p._id", method: { $ifNull: ["$$p.method", ""] },
                  netMinor: { $ifNull: ["$$p.taxInvoice.netMinor", 0] }, taxMinor: { $ifNull: ["$$p.taxInvoice.taxMinor", 0] }, amountMinor: { $ifNull: ["$$p.amountMinor", 0] },
                  // Its own payment, when that was in another currency: one part, the whole of it.
                  parts: {
                    $let: {
                      vars: { cur: paidCurrencyExpr("$$p") },
                      in: {
                        $cond: [{ $ne: ["$$cur", ""] }, [{
                          cur: "$$cur", amt: paidAmountExpr("$$p", "$$cur"), aed: { $ifNull: ["$$p.amountMinor", 0] },
                          known: { $cond: [{ $gt: [paidAmountExpr("$$p", "$$cur"), 0] }, { $ifNull: ["$$p.amountMinor", 0] }, 0] },
                          tax: { $ifNull: ["$$p.taxInvoice.taxMinor", 0] },
                        }], []],
                      },
                    },
                  },
                },
              },
            },
            [{
              kind: "invoice", number: "$invoiceNumber", date: "$issueDate", paymentId: null, method: "",
              netMinor: { $subtract: [{ $ifNull: ["$totalMinor", 0] }, { $ifNull: ["$taxTotalMinor", 0] }] }, taxMinor: { $ifNull: ["$taxTotalMinor", 0] }, amountMinor: { $ifNull: ["$totalMinor", 0] },
              // What of the invoice was paid in each other currency, with its share of the invoice's VAT.
              parts: {
                $map: {
                  input: "$invForeign", as: "f",
                  in: {
                    cur: "$$f.cur", amt: "$$f.amt", aed: "$$f.aed", known: "$$f.known",
                    tax: { $cond: [{ $gt: [fee, 0] }, half({ $divide: [{ $multiply: [{ $ifNull: ["$taxTotalMinor", 0] }, "$$f.aed"] }, fee] }), 0] },
                  },
                },
              },
            }],
          ],
        },
      },
    },
    { $unwind: "$doc" },
    { $addFields: { "doc.foreignRecordedMinor": { $sum: "$doc.parts.aed" }, "doc.foreignTaxMinor": { $sum: "$doc.parts.tax" } } },
    ...(ranged ? [{ $match: { "doc.date": range } }] : []),
    ...(like ? [{ $match: { $or: [{ "doc.number": like }, { invoiceNumber: like }, { customerName: like }] } }] : []),
    ...(paidInMatch ? [{ $match: paidInMatch }] : []),
    {
      $facet: {
        rows: [{ $sort: { "doc.date": -1, "doc.number": -1, _id: -1 } }, { $skip: (page - 1) * pageSize }, { $limit: pageSize }],
        totals: [{
          $group: {
            _id: { $ifNull: ["$currency", "AED"] }, count: { $sum: 1 }, netMinor: { $sum: "$doc.netMinor" }, taxMinor: { $sum: "$doc.taxMinor" }, amountMinor: { $sum: "$doc.amountMinor" },
            foreignRecordedMinor: { $sum: "$doc.foreignRecordedMinor" }, foreignTaxMinor: { $sum: "$doc.foreignTaxMinor" },
          },
        }],
        // Each other currency on its own, never added to another.
        foreign: [
          { $unwind: "$doc.parts" },
          {
            $group: {
              _id: { c: { $ifNull: ["$currency", "AED"] }, f: "$doc.parts.cur" }, count: { $sum: 1 },
              amountMinor: { $sum: "$doc.parts.amt" }, recordedMinor: { $sum: "$doc.parts.known" }, taxMinor: { $sum: "$doc.parts.tax" },
              unknownCount: { $sum: { $cond: [{ $gt: ["$doc.parts.aed", "$doc.parts.known"] }, 1, 0] } },
              unknownMinor: { $sum: { $subtract: ["$doc.parts.aed", "$doc.parts.known"] } },
            },
          },
          { $sort: { recordedMinor: -1, "_id.f": 1 } },
        ],
        pending: [
          { $group: { _id: "$_id", currency: { $first: { $ifNull: ["$currency", "AED"] } }, balanceMinor: { $first: { $ifNull: ["$balanceMinor", 0] } } } },
          { $group: { _id: "$currency", pendingMinor: { $sum: "$balanceMinor" } } },
        ],
      },
    },
  ]);

  const totals: Record<string, TaxDocumentTotals> = {};
  for (const t of out?.totals ?? []) {
    totals[t._id] = {
      count: t.count, netMinor: t.netMinor, taxMinor: t.taxMinor, amountMinor: t.amountMinor, pendingMinor: 0,
      foreignRecordedMinor: t.foreignRecordedMinor ?? 0, foreignTaxMinor: t.foreignTaxMinor ?? 0, foreign: [],
    };
  }
  for (const f of out?.foreign ?? []) {
    totals[f._id.c]?.foreign.push({
      currency: f._id.f, count: f.count, amountMinor: f.amountMinor ?? 0, recordedMinor: f.recordedMinor ?? 0, taxMinor: f.taxMinor ?? 0,
      unknownCount: f.unknownCount ?? 0, unknownMinor: f.unknownMinor ?? 0,
    });
  }
  for (const p of out?.pending ?? []) if (totals[p._id]) totals[p._id]!.pendingMinor = p.pendingMinor;
  const lines = (list: any[] | undefined): PaidInCurrency[] => (list ?? []).map((f) => ({ currency: String(f.cur), amountMinor: f.amt ?? 0, recordedMinor: f.aed ?? 0 }));
  const rows: TaxDocumentRow[] = (out?.rows ?? []).map((r) => ({
    kind: r.doc.kind === "ti" ? "ti" : "invoice", number: String(r.doc.number ?? ""), date: day(r.doc.date),
    invoiceId: String(r._id), invoiceNumber: String(r.invoiceNumber ?? ""), paymentId: r.doc.paymentId ? String(r.doc.paymentId) : "", method: String(r.doc.method ?? ""),
    customerId: String(r.customerId ?? ""), customerName: String(r.customerName ?? ""), currency: String(r.currency ?? "AED"),
    netMinor: r.doc.netMinor ?? 0, taxMinor: r.doc.taxMinor ?? 0, amountMinor: r.doc.amountMinor ?? 0,
    feeMinor: r.totalMinor ?? 0, paidMinor: r.amountPaidMinor ?? 0, balanceMinor: r.balanceMinor ?? 0,
    foreign: lines(r.doc.parts), foreignRecordedMinor: r.doc.foreignRecordedMinor ?? 0, foreignTaxMinor: r.doc.foreignTaxMinor ?? 0,
    invForeign: lines(r.invForeign), invForeignRecordedMinor: r.invForeignRecordedMinor ?? 0, invForeignKnownMinor: r.invForeignKnownMinor ?? 0,
  }));
  return { rows, total: Object.values(totals).reduce((s, t) => s + t.count, 0), page, pageSize, totals };
}
