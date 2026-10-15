import { Types } from "mongoose";
import { formatMoney, PAYMENT_METHODS, type PaymentMethod } from "@delta/shared";
import { AppError } from "../../lib/http";
import { logger } from "../../lib/logger";
import { sendNotice } from "../../lib/email";
import { TetraDepositModel } from "./tetra-deposit.model";

/*
 * Course payments from Tetra Commission become invoices (the user, 2026-10-12).
 *
 * Two kinds of request carry money paid for a course: a course upgrade's
 * payment (COURSE_UPGRADE, in AED) and a bonus's course payment (BONUS with a
 * `coursePayment`, the amount in USD — the AED paid at 3.67). Approved, each
 * is recorded here as a payment on an invoice, through recordPayment like
 * accounts' own, with a receipt numbered RCT-00001 that the client is emailed:
 *
 *   - an upgrade's payments all go on one invoice, made with the first one for
 *     the upgrade's price — a new upgrade (a course change) is a new invoice;
 *   - a bonus's course payment goes on the student's open invoice for that
 *     course — one made here by an earlier payment, or a sales CRM's enrolment
 *     for the same course with a balance — and on a new one when there is none,
 *     for what was paid now plus the balance Tetra Commission says is left.
 *
 * A Bangalore team's bonus (the user, 2026-10-15) arrives in the Bangalore
 * organization in rupees — `currency` INR, with `coursePayment.inrPerAed`, the
 * rate Tetra Commission's AED figures were worked out at: its invoice is in
 * rupees, the rupees paid recorded as they are and the balance turned into
 * rupees at that rate.
 *
 * Made invoices are external.source "tetra-course", need no approval (an
 * accountant approved the payment that made them) and carry no enrolment, so
 * the LMS and Tetra Commission's student flows leave them alone. Idempotent:
 * the payment's externalRef is the request's, and the request remembers what
 * it became (`courseInvoice`).
 */

export const COURSE_INVOICE_SOURCE = "tetra-course";
/** What Tetra Commission converts at — a bonus's course payment arrives in USD, its course priced in AED. */
export const AED_PER_USD = 3.67;
/** Its fixed rupee rate, 1 INR = 0.010 USD — so AED 1 = ₹27.25 — when a Bangalore request does not say its own. */
const FIXED_INR_PER_AED = 1 / (AED_PER_USD * 0.01);

/** The currency the course's invoice is in: rupees for a Bangalore team's bonus, else AED. */
export const courseCurrencyOf = (row: Row): "AED" | "INR" => (String(row?.currency ?? "").toUpperCase() === "INR" ? "INR" : "AED");
const inrPerAedOf = (row: Row) => (Number(row?.coursePayment?.inrPerAed) > 0 ? Number(row.coursePayment.inrPerAed) : FIXED_INR_PER_AED);
/** One of Tetra Commission's AED figures (the balance, paid before), in minor units of the course's currency. */
export const courseFigureMinor = (row: Row, aed: unknown): number =>
  Math.round((Number(aed) || 0) * (courseCurrencyOf(row) === "INR" ? inrPerAedOf(row) : 1) * 100);

type Row = any;

/** A course upgrade's payment, or a bonus's course payment with money paid now. */
export function isCoursePayment(row: Row): boolean {
  if (row?.type === "COURSE_UPGRADE") return true;
  return row?.type === "BONUS" && Number(row?.coursePayment?.paidTodayAed) > 0;
}

const minorAed = (aed: unknown) => Math.round((Number(aed) || 0) * 100);

/**
 * What it records, in minor units of the course's currency (courseCurrencyOf). An upgrade's is the
 * approved amount (AED). A bonus's is the AED Tetra Commission says was paid — unless the accountant
 * approved a different amount than was asked, which is then converted at 3.67. A request in AED, or
 * a Bangalore one in rupees, is taken as it is.
 */
export function coursePaymentAedMinor(row: Row): number {
  const approved = Number(row?.decision?.approvedAmountMinor ?? row?.amountMinor) || 0;
  const currency = String(row?.currency ?? "AED").toUpperCase();
  if (row?.type === "COURSE_UPGRADE" || currency === "AED" || currency === "INR") return approved;
  const asked = Number(row?.amountMinor) || 0;
  const paidToday = minorAed(row?.coursePayment?.paidTodayAed);
  if (approved === asked && paidToday > 0) return paidToday;
  return currency === "USD" ? Math.round(approved * AED_PER_USD) : approved;
}

/** The course's price for a new invoice, in its currency's minor units — never less than what is paid now. */
export function coursePriceAedMinor(row: Row, paymentMinor: number): number {
  const cp = row?.coursePayment ?? {};
  const price = row?.type === "COURSE_UPGRADE"
    ? minorAed(cp.price)
    : cp.kind === "full"
      ? paymentMinor
      : paymentMinor + courseFigureMinor(row, cp.balanceAed);
  return Math.max(price, paymentMinor);
}

const slug = (v: unknown) => String(v ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "course";

/** What a made invoice is known by: the upgrade, or the student and the course. */
export function courseKey(row: Row): string {
  const cp = row?.coursePayment ?? {};
  if (row?.type === "COURSE_UPGRADE") return cp.upgradeId ? `upgrade:${cp.upgradeId}` : `upgrade-payment:${row.externalId}`;
  return `course:${row?.student?.id || row?.student?.code || row?.student?.email}:${slug(cp.product)}`;
}

/*
 * A sales CRM's enrolment for the same course. The CRMs sell MBT and DWT (and
 * bundles of them, never matched); Tetra Commission's codes otherwise. Strict
 * on purpose: a wrong match records money on somebody's other course.
 */
const COURSE_WORDS: Record<string, RegExp> = {
  dwt: /\bdwt\b|delta wave theory/,
  mbt: /\bmbt\b|market break ?-?out/,
  msnr: /\bmsnr\b/,
  dqmp: /\bdqmp\b/,
  dslp: /\bdslp\b/,
};
export function sameCourse(product: string, invoiceCourse: string): boolean {
  const p = slug(product).split("-")[0] ?? "";
  const words = COURSE_WORDS[p];
  const course = String(invoiceCourse ?? "").toLowerCase();
  if (!words || !course || course.includes("+")) return false;
  // Every course the invoice names must be this one: "MBT + DWT" is two, and "DSLP Offer" is not "DSLP PRO".
  return words.test(course) && Object.entries(COURSE_WORDS).every(([k, re]) => k === p || !re.test(course));
}

function methodFor(raw: unknown): PaymentMethod {
  const v = String(raw ?? "").trim().toLowerCase();
  const exact = v.replace(/[\s/-]+/g, "_");
  if ((PAYMENT_METHODS as readonly string[]).includes(exact) && exact !== "easebuzz_emi") return exact as PaymentMethod;
  if (/tabby/.test(v)) return "tabby";
  if (/tamara/.test(v)) return "tamara";
  if (/link|billex|smart invoice/.test(v)) return "billexpro";
  // Rupees — "INR TRANSFER", UPI — land in the INR account, not as a bank transfer (2026-10-16).
  if (/\binr\b|upi|rupee/.test(v)) return "inr_bank_account";
  if (/cash/.test(v)) return "cash";
  if (/card/.test(v)) return "card";
  if (/bank|transfer|wire/.test(v)) return "bank_transfer";
  return "other";
}

const dayOf = (v: unknown): string => {
  const s = String(v ?? "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = v instanceof Date ? v : new Date(s);
  return Number.isNaN(d.getTime()) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10);
};

const OPEN = { status: { $nin: ["void", "paid"] }, balanceMinor: { $gt: 0 } };

/** The invoice this payment goes on, if there is one already: made here for it, or the sales CRM's for the course. */
async function openInvoiceFor(orgId: Types.ObjectId, customerId: unknown, row: Row, amountMinor: number) {
  const { Invoice } = await import("../invoice/invoice.model");
  const key = courseKey(row);
  const made = await Invoice.findOne({
    organizationId: orgId, "external.source": COURSE_INVOICE_SOURCE,
    "external.externalId": { $regex: `^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(#\\d+)?$` },
    ...(row.type === "COURSE_UPGRADE" ? {} : OPEN),
  }).sort({ createdAt: -1 }).lean<any>();
  if (made) return { invoice: made, made: true };
  if (row.type === "COURSE_UPGRADE") return null;
  const theirs = await Invoice.find({
    organizationId: orgId, customerId, currency: courseCurrencyOf(row), ...OPEN,
    "external.source": { $in: ["crm", "draw-crm", "banglore-crm"] },
    "approval.state": "approved", balanceMinor: { $gte: amountMinor },
  }).select("invoiceNumber enrolment.course lineItems.description balanceMinor currency").sort({ issueDate: 1 }).lean<any[]>();
  const product = String(row.coursePayment?.product ?? "");
  const match = theirs.find((i) => sameCourse(product, i.enrolment?.course ?? "") || (i.lineItems ?? []).length === 1 && sameCourse(product, i.lineItems[0]?.description ?? ""));
  return match ? { invoice: match, made: false } : null;
}

/** A new invoice for the course: its price, in AED (rupees for Bangalore), issued on the day it was paid, approved by the accountant who approved the payment. */
async function makeInvoice(orgId: Types.ObjectId, customerId: string, salespersonId: string, row: Row, amountMinor: number) {
  const { Invoice } = await import("../invoice/invoice.model");
  const { createInvoice } = await import("../invoice/invoice.service");
  const { Organization } = await import("../organization/organization.model");
  const cp = row.coursePayment ?? {};
  const product = String(cp.product || "Course").trim();
  const upgrade = row.type === "COURSE_UPGRADE";
  const org = await Organization.findById(orgId).select("taxRates").lean<any>();
  const taxes = ((org?.taxRates ?? []) as any[]).filter((r) => r.isDefault && r.appliesTo !== "purchases").map((r) => ({ code: r.code, rate: r.rate }));
  const key = courseKey(row);
  // A course paid in full before and bought again: the same student and course, numbered on.
  const before = upgrade ? 0 : await Invoice.countDocuments({ organizationId: orgId, "external.source": COURSE_INVOICE_SOURCE, "external.externalId": { $regex: `^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(#\\d+)?$` } });
  const externalId = before ? `${key}#${before + 1}` : key;
  const day = dayOf(cp.paidOn || row.requestedAt);
  const total = coursePriceAedMinor(row, amountMinor);
  const created = await createInvoice(String(orgId), {
    customerId,
    salespersonId,
    issueDate: day,
    dueDate: day,
    currency: courseCurrencyOf(row),
    reference: `tetra:${upgrade ? "upgrade" : "course"}:${row.externalId}`,
    notes: [
      upgrade ? `${product} course upgrade, from Tetra Commission` : `${product} course, paid through Tetra Commission`,
      row.student?.code ? `Student ${row.student.code}` : "",
      !upgrade && Number(cp.paidBeforeAed) > 0 ? `${formatMoney(courseFigureMinor(row, cp.paidBeforeAed), courseCurrencyOf(row))} paid before, not on this invoice` : "",
      courseCurrencyOf(row) === "INR" ? `Bangalore — rupees at ${inrPerAedOf(row).toFixed(4)} per AED, Tetra Commission's rate` : "",
    ].filter(Boolean).join(" · "),
    taxInclusive: true,
    lineItems: [{ description: upgrade ? `${product} — course upgrade` : `${product} — course`, quantity: 1, unitPriceMinor: total, taxes }],
  } as never, { all: true });
  await Invoice.updateOne({ _id: new Types.ObjectId(created.id) }, {
    $set: { external: { source: COURSE_INVOICE_SOURCE, externalId, flags: [] }, status: "sent" },
  });
  return Invoice.findById(created.id).lean<any>();
}

/** The next receipt number, on the payment that has none yet. */
async function issueReceipt(orgId: Types.ObjectId, invoiceId: unknown, externalRef: string): Promise<{ paymentId: string; receiptNumber: string }> {
  const { Invoice } = await import("../invoice/invoice.model");
  const { nextNumber } = await import("../sequence/sequence.service");
  const doc = await Invoice.findById(invoiceId).select("payments._id payments.externalRef payments.receiptNumber").lean<any>();
  const p = (doc?.payments ?? []).find((x: any) => x.externalRef === externalRef);
  if (!p) throw new AppError("CONFLICT", "The payment was not recorded on the invoice");
  if (p.receiptNumber) return { paymentId: String(p._id), receiptNumber: p.receiptNumber };
  const receiptNumber = await nextNumber(String(orgId), "receipt", "RCT-");
  await Invoice.updateOne(
    { _id: doc._id, payments: { $elemMatch: { _id: p._id, receiptNumber: { $exists: false } } } },
    { $set: { "payments.$.receiptNumber": receiptNumber } },
  );
  const after = await Invoice.findById(doc._id).select("payments._id payments.receiptNumber").lean<any>();
  const kept = (after?.payments ?? []).find((x: any) => String(x._id) === String(p._id));
  return { paymentId: String(p._id), receiptNumber: kept?.receiptNumber ?? receiptNumber };
}

/** The client's receipt, by email — once per request. Never throws. */
async function emailReceipt(row: Row, invoice: any, payment: { receiptNumber: string; amountMinor: number; paidOn: string; method: string }): Promise<void> {
  try {
    const to = String(row.student?.email ?? "").trim();
    if (!to) return;
    const claimed = await TetraDepositModel.updateOne(
      { _id: row._id, "courseInvoice.emailedAt": { $exists: false } },
      { $set: { "courseInvoice.emailedAt": new Date() } },
    );
    if (!claimed.modifiedCount) return;
    const { Organization } = await import("../organization/organization.model");
    const org = await Organization.findById(invoice.organizationId).select("name").lean<any>();
    const cur = invoice.currency ?? "AED";
    const course = String(row.coursePayment?.product || invoice.enrolment?.course || "your course");
    await sendNotice({
      log: { organizationId: String(invoice.organizationId), kind: "course_payment_receipt", ref: { type: "invoice", id: String(invoice._id), label: String(invoice.invoiceNumber ?? "") } },
      to: [to],
      subject: `Payment receipt ${payment.receiptNumber} — ${formatMoney(payment.amountMinor, cur)}`,
      title: `Thank you — we have received your payment`,
      lines: [
        `Dear ${row.student?.name || "student"}, this is your receipt for a payment towards ${course}.`,
        `Receipt ${payment.receiptNumber} · ${formatMoney(payment.amountMinor, cur)} · paid on ${payment.paidOn} · ${payment.method.replace(/_/g, " ")}`,
        `Invoice ${invoice.invoiceNumber}: ${formatMoney(invoice.totalMinor ?? 0, cur)} in all, ${formatMoney(invoice.amountPaidMinor ?? 0, cur)} paid, ${formatMoney(invoice.balanceMinor ?? 0, cur)} left to pay.`,
        org?.name ? `${org.name}` : "",
      ].filter(Boolean),
    });
  } catch (err) {
    logger.error({ err, depositId: String(row?._id) }, "Could not email the course payment receipt");
  }
}

/**
 * Records an approved course payment on its invoice — found or made — with
 * its receipt, and remembers it on the request. Idempotent: a retry after
 * this got part-way records nothing twice. Answers why not, when it could not.
 */
export async function recordCoursePayment(row: Row, opts: { email?: boolean } = {}): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!isCoursePayment(row)) return { ok: true };
  if (row.courseInvoice?.paymentId && row.courseInvoice?.receiptNumber) return { ok: true };
  const d = row.decision ?? {};
  const orgId = new Types.ObjectId(String(row.organizationId));
  const externalRef = `tetra:${row.externalId}`;
  const amountMinor = coursePaymentAedMinor(row);
  if (!(amountMinor > 0)) return { ok: false, message: "No amount to record" };
  const email = String(row.student?.email ?? "").trim().toLowerCase();
  if (!email) return { ok: false, message: `${row.student?.name || "The student"} has no email in Tetra Commission, so there is no client to invoice` };
  const salespersonId = String(d.decidedById ?? "");
  if (!Types.ObjectId.isValid(salespersonId)) return { ok: false, message: "Who approved it is not known" };
  try {
    const { Invoice } = await import("../invoice/invoice.model");
    const { findOrCreateCustomer } = await import("../customer/customer.service");
    const { recordPayment } = await import("../invoice/invoice.service");

    // Recorded already by a request that died before remembering it: that invoice.
    let invoice: any = row.courseInvoice?.invoiceId
      ? await Invoice.findById(row.courseInvoice.invoiceId).lean<any>()
      : await Invoice.findOne({ organizationId: orgId, "payments.externalRef": externalRef }).lean<any>();
    let created = row.courseInvoice?.created === true;
    if (!invoice) {
      const { customer } = await findOrCreateCustomer(String(orgId), { name: String(row.student?.name || email), email, phone: String(row.student?.phone || "").trim() || "Not given" } as never);
      const open = await openInvoiceFor(orgId, new Types.ObjectId(customer.id), row, amountMinor);
      if (open) invoice = open.invoice;
      else {
        invoice = await makeInvoice(orgId, customer.id, salespersonId, row, amountMinor);
        created = true;
      }
      // Remembered before the payment, so a retry finds this invoice rather than making another.
      await TetraDepositModel.updateOne({ _id: row._id }, {
        $set: { courseInvoice: { invoiceId: invoice._id, invoiceNumber: invoice.invoiceNumber, created, currency: invoice.currency ?? "AED", amountMinor } },
      });
    }

    const method = d.paymentMethod && (PAYMENT_METHODS as readonly string[]).includes(d.paymentMethod) && d.paymentMethod !== "easebuzz_emi"
      ? (d.paymentMethod as PaymentMethod)
      : methodFor(d.paymentMethod || row.paymentMethod);
    const paidOn = dayOf(row.coursePayment?.paidOn || row.requestedAt);
    await recordPayment(String(orgId), String(invoice._id), {
      method,
      amountMinor,
      paidOn,
      reference: String(d.transactionId ?? ""),
      notes: [
        row.type === "COURSE_UPGRADE" ? "Course upgrade payment from Tetra Commission" : "Course payment from Tetra Commission",
        row.requestedBy ? `recorded by ${row.requestedBy}` : "",
        `approved by ${d.decidedByName || "accounts"}`,
        row.currency === "USD" ? `${formatMoney(Number(d.approvedAmountMinor ?? row.amountMinor) || 0, "USD")} as asked` : "",
        d.note,
      ].filter(Boolean).join(" · ").slice(0, 1000),
      accountName: "",
      chargesMinor: 0,
    }, undefined, { externalRef, proofUrl: row.screenshotUrl || "" });

    const receipt = await issueReceipt(orgId, invoice._id, externalRef);
    const after = await Invoice.findById(invoice._id).lean<any>();
    await TetraDepositModel.updateOne({ _id: row._id }, {
      $set: {
        "courseInvoice.invoiceId": after._id, "courseInvoice.invoiceNumber": after.invoiceNumber,
        "courseInvoice.paymentId": receipt.paymentId, "courseInvoice.receiptNumber": receipt.receiptNumber,
        "courseInvoice.amountMinor": amountMinor, "courseInvoice.currency": after.currency ?? "AED",
        "courseInvoice.created": created, "courseInvoice.at": new Date(),
      },
      $push: {
        events: {
          at: new Date(), kind: "recorded", byName: "",
          text: `${created ? "Invoice made" : "Recorded on invoice"} ${after.invoiceNumber} — ${formatMoney(amountMinor, after.currency ?? "AED")}, receipt ${receipt.receiptNumber}; ${formatMoney(after.balanceMinor ?? 0, after.currency ?? "AED")} left`,
        },
      },
    });
    if (opts.email !== false) void emailReceipt(row, after, { receiptNumber: receipt.receiptNumber, amountMinor, paidOn, method });
    return { ok: true };
  } catch (err) {
    if (err instanceof AppError) return { ok: false, message: err.message };
    throw err;
  }
}

/**
 * What recording it would do, without doing it (the backfill's dry run): the invoice it would go
 * on, or the one it would make, and any invoice typed by hand for the same client since it was
 * raised — which may be this payment invoiced already.
 */
export async function planCoursePayment(row: Row): Promise<{
  amountMinor: number; onto: string; totalMinor: number; handTyped: string[]; refusal?: string;
}> {
  const amountMinor = coursePaymentAedMinor(row);
  const email = String(row.student?.email ?? "").trim().toLowerCase();
  if (!email) return { amountMinor, onto: "", totalMinor: 0, handTyped: [], refusal: "no email in Tetra Commission" };
  const orgId = new Types.ObjectId(String(row.organizationId));
  const { Customer } = await import("../customer/customer.model");
  const { Invoice } = await import("../invoice/invoice.model");
  const customer = await Customer.findOne({ organizationId: orgId, email }).select("_id").lean<any>();
  const open = await openInvoiceFor(orgId, customer?._id ?? new Types.ObjectId(), row, amountMinor);
  const since = new Date(new Date(row.requestedAt ?? Date.now()).getTime() - 7 * 86_400_000);
  const handTyped = customer
    ? (await Invoice.find({ organizationId: orgId, customerId: customer._id, status: { $ne: "void" }, "external.source": { $in: [null, ""] }, createdAt: { $gte: since } })
      .select("invoiceNumber").lean<any[]>()).map((i) => String(i.invoiceNumber))
    : [];
  if (open) {
    const bal = Number(open.invoice.balanceMinor) || 0;
    return { amountMinor, onto: String(open.invoice.invoiceNumber), totalMinor: Number(open.invoice.totalMinor) || 0, handTyped,
      ...(amountMinor > bal ? { refusal: `more than the ${formatMoney(bal, courseCurrencyOf(row))} left on ${open.invoice.invoiceNumber}` } : {}) };
  }
  return { amountMinor, onto: "", totalMinor: coursePriceAedMinor(row, amountMinor), handTyped };
}

/** What Tetra Commission is told with the decision: the invoice and the receipt. */
export async function courseInvoiceForDecision(row: Row) {
  const ci = row?.courseInvoice;
  if (!ci?.paymentId || !ci?.invoiceId) return undefined;
  const { Invoice } = await import("../invoice/invoice.model");
  const inv = await Invoice.findById(ci.invoiceId).select("invoiceNumber totalMinor amountPaidMinor balanceMinor currency").lean<any>();
  if (!inv) return undefined;
  return {
    invoiceId: String(inv._id),
    invoiceNumber: String(inv.invoiceNumber ?? ""),
    paymentId: String(ci.paymentId),
    receiptNumber: String(ci.receiptNumber ?? ""),
    amountMinor: Number(ci.amountMinor) || 0,
    currency: String(inv.currency ?? "AED"),
    totalMinor: Number(inv.totalMinor) || 0,
    paidMinor: Number(inv.amountPaidMinor) || 0,
    balanceMinor: Number(inv.balanceMinor) || 0,
    created: ci.created === true,
  };
}
