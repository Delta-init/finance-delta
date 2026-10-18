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

  const applyAmount = Math.min(remaining, invoice.balanceMinor ?? 0);
  invoice.balanceMinor = (invoice.balanceMinor ?? 0) - applyAmount;
  invoice.amountPaidMinor = (invoice.amountPaidMinor ?? 0) + applyAmount;
  if (invoice.balanceMinor <= 0) invoice.status = "paid";
  else if (invoice.amountPaidMinor > 0) invoice.status = "partial";
  await invoice.save();
  // Credit that settles an enrolment opens the rest of its course in the LMS.
  void import("../invoice/invoice.service").then((m) => m.syncLmsAccess(invoice as never));
  // And Tetra Commission is told, where the student went there.
  void import("../integrations/commission-fee-update.service").then((m) => m.queueFeeUpdate(invoice._id, "credit note")).catch(() => undefined);

  cn.amountAppliedMinor = (cn.amountAppliedMinor ?? 0) + applyAmount;
  if (cn.amountAppliedMinor >= (cn.totalMinor ?? 0)) cn.status = "applied";
  await cn.save();

  return toDTO(cn as unknown as CreditNoteDoc);
}

export async function voidCreditNote(orgId: string, id: string): Promise<DTO> {
  const doc = await CreditNote.findOne({ _id: id, organizationId: orgId });
  if (!doc) throw new AppError("NOT_FOUND", "Credit note not found");
  if (doc.status === "applied") throw new AppError("CONFLICT", "Applied credit notes cannot be voided");
  doc.status = "voided";
  await doc.save();
  return toDTO(doc as unknown as CreditNoteDoc);
}
