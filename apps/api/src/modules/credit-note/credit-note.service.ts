import { Types } from "mongoose";
import type { CreateCreditNoteInput, CreditNote as DTO, ApplyCreditNoteInput, ListQuery, Paginated } from "@delta/shared";
import { buildSort, pageMeta, searchOr, skipFor } from "../../lib/paginate";
import { AppError } from "../../lib/http";
import { nextNumber } from "../sequence/sequence.service";
import { Invoice } from "../invoice/invoice.model";
import { computeInvoiceLine, sumInvoiceTotals } from "@delta/shared";
import { CreditNote, type CreditNoteDoc } from "./credit-note.model";

function toDTO(doc: CreditNoteDoc): DTO {
  return {
    id: String(doc._id),
    creditNoteNumber: doc.creditNoteNumber,
    invoiceId: String(doc.invoiceId),
    invoiceNumber: doc.invoiceNumber,
    customerId: String(doc.customerId),
    customerName: doc.customerName,
    reason: doc.reason,
    status: doc.status as DTO["status"],
    lineItems: (doc.lineItems as unknown as DTO["lineItems"]),
    subtotalMinor: doc.subtotalMinor ?? 0,
    taxTotalMinor: doc.taxTotalMinor ?? 0,
    totalMinor: doc.totalMinor ?? 0,
    amountAppliedMinor: doc.amountAppliedMinor ?? 0,
    currency: doc.currency ?? "AED",
    issuedAt: doc.issuedAt ? doc.issuedAt.toISOString() : undefined,
    createdAt: doc.createdAt.toISOString(),
  };
}

export async function createCreditNote(orgId: string, input: CreateCreditNoteInput): Promise<DTO> {
  const invoice = await Invoice.findOne({ _id: input.invoiceId, organizationId: orgId });
  if (!invoice) throw new AppError("NOT_FOUND", "Invoice not found");
  if (["void"].includes(invoice.status as string)) throw new AppError("CONFLICT", "Cannot credit a voided invoice");

  /**
   * A credit note prices the way the invoice it credits did.
   *
   * It used to keep its own arithmetic and always add tax on top, so crediting
   * a tax-inclusive invoice gave back more than had been charged — 110.25
   * against a line invoiced at 105.00, because the 5% already inside the price
   * was applied a second time. Using the shared calculator, with the invoice's
   * own basis, is what keeps a full credit equal to the invoice.
   */
  const taxInclusive = (invoice as unknown as { taxInclusive?: boolean }).taxInclusive ?? false;
  const calcInput = input.lineItems.map((l) => ({
    quantity: l.quantity,
    unitPriceMinor: l.unitPriceMinor,
    discountPct: l.discountPct,
    taxPct: l.taxPct,
    taxInclusive,
  }));

  const lines = input.lineItems.map((l, i) => ({
    ...l,
    lineTotalMinor: computeInvoiceLine(calcInput[i]!).lineTotalMinor,
  }));
  const totals = sumInvoiceTotals(calcInput);
  const { subtotalMinor, taxTotalMinor, totalMinor } = totals;
  const creditNoteNumber = await nextNumber(orgId, "credit-note", "CN");

  const doc = await CreditNote.create({
    organizationId: new Types.ObjectId(orgId),
    creditNoteNumber,
    invoiceId: new Types.ObjectId(input.invoiceId),
    invoiceNumber: invoice.invoiceNumber,
    customerId: invoice.customerId,
    customerName: invoice.customerName,
    reason: input.reason,
    status: "draft",
    lineItems: lines,
    subtotalMinor,
    taxTotalMinor,
    totalMinor,
    amountAppliedMinor: 0,
    currency: invoice.currency ?? "AED",
  });
  return toDTO(doc as unknown as CreditNoteDoc);
}

export async function listCreditNotes(orgId: string): Promise<DTO[]> {
  const docs = await CreditNote.find({ organizationId: orgId }).sort({ createdAt: -1, _id: -1 }).limit(200);
  return docs.map((d) => toDTO(d as unknown as CreditNoteDoc));
}

const CREDIT_NOTE_SORT = {
  number: "creditNoteNumber", customer: "customerName", invoice: "invoiceNumber", status: "status",
  total: "totalMinor", createdAt: "createdAt",
} as const;

/**
 * Credit notes a page at a time, searched and filtered (2026-10-18): the list used to stop at the newest 200, for the
 * table and its export alike. Asked for with `page`; without it, the newest 200 as before.
 */
export async function listCreditNotesPaged(orgId: string, query: ListQuery & { status?: string }): Promise<Paginated<DTO>> {
  const filter: Record<string, unknown> = { organizationId: new Types.ObjectId(orgId) };
  if (query.status) filter.status = query.status;
  const or = searchOr(query.q, ["creditNoteNumber", "customerName", "invoiceNumber", "reason"]);
  if (or) filter.$or = or;
  const [docs, total] = await Promise.all([
    CreditNote.find(filter).sort(buildSort(CREDIT_NOTE_SORT, query.sort, query.dir)).skip(skipFor(query.page, query.pageSize)).limit(query.pageSize),
    CreditNote.countDocuments(filter),
  ]);
  return { data: docs.map((d) => toDTO(d as unknown as CreditNoteDoc)), meta: pageMeta(total, query.page, query.pageSize) };
}

export async function getCreditNote(orgId: string, id: string): Promise<DTO> {
  const doc = await CreditNote.findOne({ _id: id, organizationId: orgId });
  if (!doc) throw new AppError("NOT_FOUND", "Credit note not found");
  return toDTO(doc as unknown as CreditNoteDoc);
}

export async function issueCreditNote(orgId: string, id: string): Promise<DTO> {
  const doc = await CreditNote.findOne({ _id: id, organizationId: orgId });
  if (!doc) throw new AppError("NOT_FOUND", "Credit note not found");
  if (doc.status !== "draft") throw new AppError("CONFLICT", "Credit note is not a draft");
  doc.status = "issued";
  doc.issuedAt = new Date();
  await doc.save();
  return toDTO(doc as unknown as CreditNoteDoc);
}

/*
 * Credit applied to an invoice is kept apart from its payments (2026-11-27, audit F05). An invoice's payments[] holds
 * money received only. amountPaidMinor stays what it always meant — settled, payments and credit together — so
 * paid/part-paid status, the LMS and commission eligibility read as before. Whatever of it is not payments (the credit,
 * however and whenever it was applied) is carried across a payment edit or delete instead of being recomputed from the
 * payments alone (invoice.service: settledBesidePayments). Nothing assumes where an older note's credit went
 * (validation, 2026-11-27): a note applied before its applications were recorded is never counted on any invoice by
 * guesswork, and voiding one is refused for a person to look at.
 */

type NoteLike = { amountAppliedMinor?: number | null; applications?: { invoiceId: unknown; amountMinor: number }[] | null };

/** What of a note's applied credit has no recorded destination (applied before applications were kept). */
export function unrecordedCredit(note: NoteLike): number {
  const listed = (note.applications ?? []).reduce((n, a) => n + (Number(a.amountMinor) || 0), 0);
  return Math.max(0, (Number(note.amountAppliedMinor) || 0) - listed);
}

const versionOf = (doc: unknown): number | undefined => {
  const v = (doc as { __v?: unknown }).__v;
  return typeof v === "number" ? v : undefined;
};

export async function applyCreditNote(orgId: string, id: string, input: ApplyCreditNoteInput): Promise<DTO> {
  const cn = await CreditNote.findOne({ _id: id, organizationId: orgId });
  if (!cn) throw new AppError("NOT_FOUND", "Credit note not found");
  if (cn.status !== "issued") throw new AppError("CONFLICT", "Credit note must be issued before applying");

  const remaining = (cn.totalMinor ?? 0) - (cn.amountAppliedMinor ?? 0);
  if (remaining <= 0) throw new AppError("CONFLICT", "Credit note has no remaining balance");

  const targetId = input.targetInvoiceId ?? String(cn.invoiceId);
  const invoice = await Invoice.findOne({ _id: targetId, organizationId: orgId });
  if (!invoice) throw new AppError("NOT_FOUND", "Target invoice not found");
  if (invoice.status === "void") throw new AppError("CONFLICT", "Cannot apply credit to a voided invoice");
  // A credit in one currency never settles an invoice in another (audit F05).
  if (String(invoice.currency ?? "AED").toUpperCase() !== String(cn.currency ?? "AED").toUpperCase()) {
    throw new AppError("CONFLICT", `This credit note is in ${cn.currency ?? "AED"} and invoice ${invoice.invoiceNumber} is in ${invoice.currency ?? "AED"} — a credit can only be applied to an invoice in its own currency.`);
  }

  const applyAmount = Math.min(remaining, invoice.balanceMinor ?? 0);
  if (applyAmount <= 0) throw new AppError("CONFLICT", `Invoice ${invoice.invoiceNumber} has nothing left to settle`);

  // The note first, and only if nobody applied it meanwhile: its applied amount must still be what was read.
  const before = cn.amountAppliedMinor ?? 0;
  const after = before + applyAmount;
  const claim = await CreditNote.updateOne(
    { _id: cn._id, status: "issued", amountAppliedMinor: before },
    {
      $set: { amountAppliedMinor: after, ...(after >= (cn.totalMinor ?? 0) ? { status: "applied" } : {}) },
      $push: { applications: { invoiceId: invoice._id, amountMinor: applyAmount, appliedAt: new Date() } },
    },
  );
  if (!claim.modifiedCount) throw new AppError("CONFLICT", "This credit note was applied by somebody else just now — refresh and look again.");

  // Then the invoice, in one atomic step and only if nobody changed it since it was read (its version): a payment
  // recorded, edited or deleted, or another credit applied, at the same moment is never overwritten (validation).
  const balanceAfter = (invoice.balanceMinor ?? 0) - applyAmount;
  const settledAfter = (invoice.amountPaidMinor ?? 0) + applyAmount;
  const took = await Invoice.updateOne(
    // An invoice written without a version (older imports) is matched by having none.
    { _id: invoice._id, organizationId: invoice.organizationId, __v: versionOf(invoice) ?? { $exists: false }, status: { $ne: "void" }, balanceMinor: invoice.balanceMinor ?? 0 },
    { $set: { balanceMinor: balanceAfter, amountPaidMinor: settledAfter, status: balanceAfter <= 0 ? "paid" : "partial" }, $inc: { __v: 1 } },
  );
  if (!took.modifiedCount) {
    // The invoice did not take it: the note gives the credit back, so the two never disagree.
    await CreditNote.updateOne(
      { _id: cn._id, amountAppliedMinor: after },
      { $set: { amountAppliedMinor: before, status: "issued" }, $pull: { applications: { invoiceId: invoice._id, amountMinor: applyAmount } } },
    );
    throw new AppError("CONFLICT", `Invoice ${invoice.invoiceNumber} changed just now — refresh and apply the credit again.`);
  }
  invoice.balanceMinor = balanceAfter;
  invoice.amountPaidMinor = settledAfter;
  // Credit that settles an enrolment opens the rest of its course in the LMS.
  void import("../invoice/invoice.service").then((m) => m.syncLmsAccess(invoice as never));
  // And CS Portal is told, where the student went there.
  void import("../integrations/commission-fee-update.service").then((m) => m.queueFeeUpdate(invoice._id, "credit note")).catch(() => undefined);

  const fresh = await CreditNote.findById(cn._id);
  return toDTO(fresh as unknown as CreditNoteDoc);
}

export async function voidCreditNote(orgId: string, id: string): Promise<DTO> {
  const doc = await CreditNote.findOne({ _id: id, organizationId: orgId });
  if (!doc) throw new AppError("NOT_FOUND", "Credit note not found");
  if (doc.status === "applied") throw new AppError("CONFLICT", "Applied credit notes cannot be voided");
  if (doc.status === "voided") return toDTO(doc as unknown as CreditNoteDoc);
  // Credit applied before destinations were recorded: which invoice it went to is not known, so it is not guessed —
  // voiding is refused for a person to look at (validation, 2026-11-27).
  const unknown = unrecordedCredit(doc as unknown as NoteLike);
  if (unknown > 0) {
    throw new AppError("CONFLICT", `This credit note was applied before finance recorded which invoice each credit went to, so the credit it took off cannot be given back safely. Ask accounts to review it before voiding.`);
  }
  // What it took off each invoice, from its own record.
  const back = new Map<string, number>();
  for (const a of doc.applications ?? []) back.set(String(a.invoiceId), (back.get(String(a.invoiceId)) ?? 0) + (Number(a.amountMinor) || 0));
  const r = await CreditNote.updateOne({ _id: doc._id, status: doc.status, amountAppliedMinor: doc.amountAppliedMinor ?? 0 }, { $set: { status: "voided" } });
  if (!r.modifiedCount) throw new AppError("CONFLICT", "This credit note changed just now — refresh and look again.");
  // Voiding gives the credit back to each invoice it took it off (audit F05). It used to leave the invoices reduced by a
  // note that no longer counted.
  const { giveCreditBack } = await import("../invoice/invoice.service");
  for (const [invoiceId, amount] of back) if (amount > 0) await giveCreditBack(orgId, invoiceId, amount, "credit note voided");
  const fresh = await CreditNote.findById(doc._id);
  return toDTO(fresh as unknown as CreditNoteDoc);
}
