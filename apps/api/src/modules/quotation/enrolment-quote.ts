import { Types } from "mongoose";
import { logger } from "../../lib/logger";
import { nextNumber } from "../sequence/sequence.service";
import { Quotation } from "./quotation.model";

/* ─────────────────────────────────────────────────────────────────────────────
   An enrolment as Zoho Books would keep it (the user, 2026-11-11: "instead of
   pro-forma TIs we need exact same as the quotation based system same as the
   Zoho Books have"): Quote → accepted → one invoice for the whole fee → each
   payment recorded against that invoice (partially paid, then paid).

   A close arriving from a sales CRM — or typed as an enrolment — is a quote
   (QT-…) for the whole course fee, waiting in Approvals. Approving it accepts
   the quote and converts it into the invoice, which gets its invoice number
   then; sent back, the quote is a draft again; voided or deleted, declined.

   Underneath, the enrolment is one record all along — the invoice the CRMs,
   CS Portal, the LMS and the reminders already know — and the quote is kept in
   step with it here, after every change. Never throws: an enrolment is not
   stopped because its quote could not be written.
───────────────────────────────────────────────────────────────────────────── */

export const QUOTE_PREFIX = "QT-";
/** The number an enrolment carries until it is approved is its quote's. */
export const isQuoteNumber = (n: unknown) => String(n ?? "").startsWith(QUOTE_PREFIX);
export const nextQuoteNumber = (orgId: string) => nextNumber(orgId, "quotation", QUOTE_PREFIX);

const DAY = 86_400_000;
const oid = (v: unknown) => new Types.ObjectId(String(v));

/** An invoice's lines as a quote keeps them. */
function quoteLines(inv: any) {
  return ((inv.lineItems ?? []) as any[]).map((l) => {
    const taxes = ((l.taxes ?? []) as any[]).map((t) => ({ code: String(t.code), rate: Number(t.rate) || 0 }));
    return {
      description: String(l.description ?? ""), quantity: Number(l.quantity) || 0, unitPriceMinor: Number(l.unitPriceMinor) || 0,
      discountPct: Number(l.discountPct) || 0, taxPct: taxes.reduce((s, t) => s + t.rate, 0), taxes,
      ...(l.itemId ? { itemId: String(l.itemId) } : {}),
      lineSubtotalMinor: Number(l.lineSubtotalMinor) || 0, discountMinor: Number(l.discountMinor) || 0,
      taxMinor: Number(l.taxTotalMinor) || 0, lineTotalMinor: Number(l.lineTotalMinor) || 0,
    };
  });
}

/**
 * Brings an enrolment's quote into line with it — made the first time. Returns the quote's id and number, or null
 * when the invoice is not an enrolment that goes through Approvals (or the quote could not be written).
 */
export async function syncEnrolmentQuote(orgId: string, invoiceId: unknown): Promise<{ id: string; number: string } | null> {
  try {
    const { Invoice } = await import("../invoice/invoice.model");
    const inv = await Invoice.findOne({ _id: oid(invoiceId), organizationId: oid(orgId) }).lean<any>();
    if (!inv?.enrolment) return null;
    const state = String(inv.approval?.state ?? "not_required");
    let q = await Quotation.findOne({ organizationId: inv.organizationId, "enrolment.invoiceId": inv._id });
    // Never went through Approvals (old books, a course invoice from CS Portal): no quote.
    if (!q && state === "not_required") return null;

    const voided = inv.status === "void";
    const approved = state === "approved" && !voided;
    const status = voided ? "declined" : approved ? "accepted" : state === "returned" ? "draft" : "sent";
    const total = Number(inv.totalMinor) || 0;
    const figures = {
      customerId: inv.customerId, customerName: String(inv.customerName ?? ""), currency: String(inv.currency ?? "AED"),
      lineItems: quoteLines(inv), subtotalMinor: Number(inv.subtotalMinor) || 0, discountTotalMinor: Number(inv.discountTotalMinor) || 0,
      taxTotalMinor: Number(inv.taxTotalMinor) || 0,
      taxBreakdown: ((inv.taxBreakdown ?? []) as any[]).filter((b) => b?.code).map((b) => ({ code: String(b.code), amountMinor: Number(b.amountMinor) || 0 })),
      totalMinor: total, taxInclusive: Boolean(inv.taxInclusive), tagIds: inv.tagIds ?? [],
    };
    const now = new Date();
    if (!q) {
      // Its number is the one the enrolment has carried since the close — or, for one from before this, the next.
      const quoteNumber = isQuoteNumber(inv.invoiceNumber) ? String(inv.invoiceNumber) : await nextQuoteNumber(orgId);
      // Dated the day of the close, as the enrolment is.
      const issued = new Date(inv.issueDate ?? inv.createdAt ?? now);
      q = await Quotation.create({
        organizationId: inv.organizationId, quoteNumber, ...figures, status,
        issueDate: issued, expiryDate: new Date(issued.getTime() + 30 * DAY), notes: "", terms: "",
        enrolment: { invoiceId: inv._id, source: inv.external?.source ?? undefined, externalId: inv.external?.externalId ?? undefined },
        sentAt: issued,
      });
    }
    const d = q as any;
    Object.assign(d, figures);
    d.status = status;
    // A correction can move the day of the close: the quote's date follows it.
    if (inv.issueDate && new Date(inv.issueDate).getTime() !== new Date(d.issueDate).getTime()) {
      d.issueDate = new Date(inv.issueDate);
      d.expiryDate = new Date(d.issueDate.getTime() + 30 * DAY);
    }
    if (inv.external?.source && !d.enrolment?.source) d.enrolment = { ...(d.enrolment?.toObject?.() ?? d.enrolment), source: inv.external.source, externalId: inv.external.externalId };
    if (approved) {
      d.acceptedAt = d.acceptedAt ?? new Date(inv.approval?.at ?? now);
      d.invoicedMinor = total;
      d.convertedTo = { ...(d.convertedTo?.toObject?.() ?? {}), invoiceId: inv._id, invoiceIds: [inv._id] };
    } else {
      d.invoicedMinor = 0;
      d.convertedTo = undefined;
      if (voided) d.declinedAt = d.declinedAt ?? now;
    }
    await q.save();
    const link = { id: String(q._id), number: String(q.quoteNumber) };
    if (String(inv.quote?.id ?? "") !== link.id || inv.quote?.number !== link.number) {
      await Invoice.updateOne({ _id: inv._id }, { $set: { quote: { id: q._id, number: q.quoteNumber } } });
    }
    return link;
  } catch (err) {
    logger.warn({ err: (err as Error).message, invoiceId: String(invoiceId) }, "An enrolment's quote could not be brought into line");
    return null;
  }
}

/** The enrolment was deleted before it became an invoice: its quote is declined, and kept for the record. */
export async function closeEnrolmentQuote(orgId: string, invoiceId: unknown): Promise<void> {
  try {
    await Quotation.updateOne(
      { organizationId: oid(orgId), "enrolment.invoiceId": oid(invoiceId) },
      { $set: { status: "declined", declinedAt: new Date(), invoicedMinor: 0, "enrolment.deleted": true }, $unset: { convertedTo: "" } },
    );
  } catch (err) {
    logger.warn({ err: (err as Error).message, invoiceId: String(invoiceId) }, "A deleted enrolment's quote could not be declined");
  }
}
