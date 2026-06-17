import { Types } from "mongoose";
import type { CreateCreditNoteInput, CreditNote as DTO, ApplyCreditNoteInput } from "@delta/shared";
import { AppError } from "../../lib/http";
import { nextNumber } from "../sequence/sequence.service";
import { Invoice } from "../invoice/invoice.model";
import { CreditNote, type CreditNoteDoc } from "./credit-note.model";

function lineTotal(l: { quantity: number; unitPriceMinor: number; discountPct: number; taxPct: number }) {
  const sub = l.quantity * l.unitPriceMinor;
  const disc = Math.round(sub * l.discountPct / 100);
  const taxable = sub - disc;
  const tax = Math.round(taxable * l.taxPct / 100);
  return taxable + tax;
}

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

  const lines = input.lineItems.map((l) => ({ ...l, lineTotalMinor: lineTotal(l) }));
  const subtotalMinor = lines.reduce((s, l) => s + l.quantity * l.unitPriceMinor, 0);
  const taxTotalMinor = lines.reduce((s, l) => {
    const taxable = l.quantity * l.unitPriceMinor - Math.round(l.quantity * l.unitPriceMinor * l.discountPct / 100);
    return s + Math.round(taxable * l.taxPct / 100);
  }, 0);
  const totalMinor = lines.reduce((s, l) => s + l.lineTotalMinor, 0);
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
  const docs = await CreditNote.find({ organizationId: orgId }).sort({ createdAt: -1 }).limit(200);
  return docs.map((d) => toDTO(d as unknown as CreditNoteDoc));
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
