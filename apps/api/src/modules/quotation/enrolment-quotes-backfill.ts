import { Types } from "mongoose";
import { Quotation } from "./quotation.model";
import { syncEnrolmentQuote } from "./enrolment-quote";

/* ─────────────────────────────────────────────────────────────────────────────
   Enrolments from before quotes (2026-11-11) brought to the same footing.

   1. Pro-formas → ordinary invoices. An enrolment approved part paid was a
      pro-forma with a tax invoice (TI-…) per payment. It becomes what it would
      be now: one invoice for the whole fee, each payment recorded against it.
      The TI numbers stay on the payments, as the record of what was sent — but
      the VAT is the invoice's again, on its own date.
   2. Closes still waiting in Approvals (or sent back) get their quote. They
      keep the invoice number they were given at the close.

   Approved invoices are left as they are — no quote is made up for them.
   Nothing is written unless `write`; what was changed is returned, to undo.
───────────────────────────────────────────────────────────────────────────── */

export interface BackfillProforma {
  invoiceId: string; orgId: string; invoiceNumber: string; currency: string; totalMinor: number; taxTotalMinor: number;
  amountPaidMinor: number; balanceMinor: number; issueDate: string; proformaAt: string; taxInvoices: string[]; taxInvoicedMinor: number;
}
export interface BackfillWaiting {
  invoiceId: string; orgId: string; invoiceNumber: string; currency: string; totalMinor: number; state: string;
  quoteId?: string; quoteNumber?: string;
}
export interface BackfillResult { proformas: BackfillProforma[]; waiting: BackfillWaiting[]; at: string }

const day = (d: unknown) => (d ? new Date(d as Date).toISOString().slice(0, 10) : "");

export async function backfillEnrolmentQuotes(opts: { write: boolean; orgId?: string }): Promise<BackfillResult> {
  const { Invoice } = await import("../invoice/invoice.model");
  const now = new Date();
  const scope = opts.orgId ? { organizationId: new Types.ObjectId(opts.orgId) } : {};

  const proformas: BackfillProforma[] = [];
  const were = await Invoice.find({ ...scope, "proforma.at": { $exists: true } })
    .select("organizationId invoiceNumber currency totalMinor taxTotalMinor amountPaidMinor balanceMinor issueDate proforma payments.taxInvoice")
    .sort({ issueDate: 1, invoiceNumber: 1 }).lean<any[]>();
  for (const d of were) {
    const tis = ((d.payments ?? []) as any[]).filter((p) => p.taxInvoice?.number);
    proformas.push({
      invoiceId: String(d._id), orgId: String(d.organizationId), invoiceNumber: String(d.invoiceNumber), currency: String(d.currency ?? "AED"),
      totalMinor: d.totalMinor ?? 0, taxTotalMinor: d.taxTotalMinor ?? 0, amountPaidMinor: d.amountPaidMinor ?? 0, balanceMinor: d.balanceMinor ?? 0,
      issueDate: day(d.issueDate), proformaAt: new Date(d.proforma.at).toISOString(),
      taxInvoices: tis.map((p) => String(p.taxInvoice.number)), taxInvoicedMinor: tis.reduce((s, p) => s + (p.taxInvoice.taxMinor ?? 0), 0),
    });
    if (opts.write) {
      await Invoice.updateOne({ _id: d._id, "proforma.at": { $exists: true } }, { $unset: { proforma: "" }, $set: { proformaUntil: now } });
    }
  }

  const waiting: BackfillWaiting[] = [];
  const open = await Invoice.find({
    ...scope, enrolment: { $exists: true }, "approval.state": { $in: ["pending", "returned"] }, status: { $ne: "void" }, "quote.id": { $exists: false },
  }).select("organizationId invoiceNumber currency totalMinor approval.state").sort({ createdAt: 1 }).lean<any[]>();
  for (const d of open) {
    const row: BackfillWaiting = {
      invoiceId: String(d._id), orgId: String(d.organizationId), invoiceNumber: String(d.invoiceNumber), currency: String(d.currency ?? "AED"),
      totalMinor: d.totalMinor ?? 0, state: String(d.approval?.state ?? ""),
    };
    if (opts.write) {
      const q = await syncEnrolmentQuote(row.orgId, d._id);
      if (q) { row.quoteId = q.id; row.quoteNumber = q.number; }
    }
    waiting.push(row);
  }
  return { proformas, waiting, at: now.toISOString() };
}

/**
 * Puts back what a run changed, from its undo file: the pro-formas are pro-formas again and the quotes it made are
 * gone. A quote whose enrolment was approved since is left — it is that invoice's quote now.
 */
export async function undoEnrolmentQuotesBackfill(done: BackfillResult): Promise<{ proformas: number; quotes: number; kept: number }> {
  const { Invoice } = await import("../invoice/invoice.model");
  let proformas = 0;
  for (const p of done.proformas) {
    const r = await Invoice.updateOne(
      { _id: new Types.ObjectId(p.invoiceId), "proforma.at": { $exists: false }, proformaUntil: { $exists: true } },
      { $set: { proforma: { at: new Date(p.proformaAt) } }, $unset: { proformaUntil: "" } },
    );
    proformas += r.modifiedCount;
  }
  let quotes = 0, kept = 0;
  for (const w of done.waiting) {
    if (!w.quoteId) continue;
    const inv = await Invoice.findById(w.invoiceId).select("approval.state").lean<any>();
    if (inv && inv.approval?.state === "approved") { kept++; continue; }
    const r = await Quotation.deleteOne({ _id: new Types.ObjectId(w.quoteId), "enrolment.invoiceId": new Types.ObjectId(w.invoiceId) });
    if (r.deletedCount) {
      quotes++;
      await Invoice.updateOne({ _id: new Types.ObjectId(w.invoiceId), "quote.id": new Types.ObjectId(w.quoteId) }, { $unset: { quote: "" } });
    }
  }
  return { proformas, quotes, kept };
}
