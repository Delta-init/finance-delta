import { Types } from "mongoose";
import type {
  ConvertQuotationInput,
  CreateQuotationInput,
  Invoice as InvoiceDTO,
  Paginated,
  Quotation as QuotationDTO,
  QuotationQuery,
  QuoteStatus,
  SalesOrder as SalesOrderDTO,
  UpdateQuotationInput,
} from "@delta/shared";
import { computeInvoiceLine, sumInvoiceTotals } from "@delta/shared";
import { AppError } from "../../lib/http";
import { buildSort, pageMeta, searchOr, skipFor } from "../../lib/paginate";
import { resolveTagIds, toTagRefs } from "../../lib/tags";
import { nextNumber } from "../sequence/sequence.service";
import { Customer } from "../customer/customer.model";
import { User } from "../user/user.model";
import { Organization } from "../organization/organization.model";
import { Invoice } from "../invoice/invoice.model";
import { Quotation, type QuotationDoc } from "./quotation.model";
import {
  buildLines,
  createFromQuote,
  toDTO as salesOrderToDTO,
} from "../salesorder/salesorder.service";

/** Lazily reflect expiry: a draft/sent quote past its expiry date reads as expired. */
function effectiveStatus(doc: QuotationDoc): QuoteStatus {
  const stored = doc.status as QuoteStatus;
  if (
    (stored === "draft" || stored === "sent") &&
    doc.expiryDate &&
    doc.expiryDate.getTime() < Date.now()
  ) {
    return "expired";
  }
  return stored;
}

const dateOnly = (d: Date) => d.toISOString().slice(0, 10);

function toDTO(doc: QuotationDoc): QuotationDTO {
  return {
    id: doc._id.toString(),
    quoteNumber: doc.quoteNumber,
    customerId: doc.customerId.toString(),
    customerName: doc.customerName,
    status: effectiveStatus(doc),
    issueDate: dateOnly(doc.issueDate),
    expiryDate: dateOnly(doc.expiryDate),
    currency: doc.currency ?? "AED",
    lineItems: doc.lineItems as QuotationDTO["lineItems"],
    subtotalMinor: doc.subtotalMinor ?? 0,
    discountTotalMinor: doc.discountTotalMinor ?? 0,
    taxTotalMinor: doc.taxTotalMinor ?? 0,
    taxBreakdown: (doc.taxBreakdown ?? []) as QuotationDTO["taxBreakdown"],
    totalMinor: doc.totalMinor ?? 0,
    notes: doc.notes ?? "",
    terms: doc.terms ?? "",
    tags: toTagRefs(doc.tagIds),
    convertedTo: doc.convertedTo
      ? {
          salesOrderId: doc.convertedTo.salesOrderId?.toString(),
          invoiceId: doc.convertedTo.invoiceId?.toString(),
        }
      : undefined,
    createdAt: doc.createdAt.toISOString(),
  };
}

async function findDoc(orgId: string, id: string) {
  const doc = await Quotation.findOne({ _id: id, organizationId: orgId });
  if (!doc) throw new AppError("NOT_FOUND", "Quotation not found");
  return doc;
}

const SORT = {
  number: "quoteNumber",
  customer: "customerName",
  issue: "issueDate",
  expiry: "expiryDate",
  status: "status",
  total: "totalMinor",
  createdAt: "createdAt",
} as const;

export async function listQuotations(
  orgId: string,
  query: QuotationQuery,
): Promise<Paginated<QuotationDTO>> {
  const now = new Date();
  const and: Record<string, unknown>[] = [];
  const or = searchOr(query.q, ["quoteNumber", "customerName"]);
  if (or) and.push({ $or: or });

  // Expiry-aware status filter
  if (query.status === "expired") {
    and.push({ status: { $in: ["draft", "sent"] }, expiryDate: { $lt: now } });
  } else if (query.status === "draft" || query.status === "sent") {
    and.push({ status: query.status, expiryDate: { $gte: now } });
  } else if (query.status) {
    and.push({ status: query.status });
  }

  if (query.issueFrom) and.push({ issueDate: { $gte: new Date(query.issueFrom) } });
  if (query.issueTo) and.push({ issueDate: { $lte: new Date(query.issueTo) } });
  if (query.expiryFrom) and.push({ expiryDate: { $gte: new Date(query.expiryFrom) } });
  if (query.expiryTo) and.push({ expiryDate: { $lte: new Date(query.expiryTo) } });
  if (query.tagIds?.length) and.push({ tagIds: { $in: query.tagIds } });

  const filter: Record<string, unknown> = { organizationId: orgId };
  if (and.length) filter.$and = and;

  const sort = buildSort(SORT, query.sort, query.dir);
  const [rows, total] = await Promise.all([
    Quotation.find(filter)
      .populate("tagIds", "name color")
      .sort(sort)
      .skip(skipFor(query.page, query.pageSize))
      .limit(query.pageSize),
    Quotation.countDocuments(filter),
  ]);
  return {
    data: rows.map((r) => toDTO(r as unknown as QuotationDoc)),
    meta: pageMeta(total, query.page, query.pageSize),
  };
}

export async function getQuotation(orgId: string, id: string): Promise<QuotationDTO> {
  const doc = await Quotation.findOne({ _id: id, organizationId: orgId }).populate(
    "tagIds",
    "name color",
  );
  if (!doc) throw new AppError("NOT_FOUND", "Quotation not found");
  return toDTO(doc as unknown as QuotationDoc);
}

export async function createQuotation(
  orgId: string,
  input: CreateQuotationInput,
): Promise<QuotationDTO> {
  const customer = await Customer.findOne({ _id: input.customerId, organizationId: orgId });
  if (!customer) throw new AppError("VALIDATION_ERROR", "Invalid customer selected");

  const { lineItems, totals } = buildLines(input.lineItems);
  const quoteNumber = await nextNumber(orgId, "quotation", "QT-");
  const tagIds = await resolveTagIds(orgId, input.tagIds);

  const doc = await Quotation.create({
    organizationId: new Types.ObjectId(orgId),
    quoteNumber,
    customerId: customer._id,
    customerName: customer.name,
    status: "draft",
    issueDate: new Date(input.issueDate),
    expiryDate: new Date(input.expiryDate),
    currency: input.currency ?? customer.currency ?? "AED",
    lineItems,
    ...totals,
    notes: input.notes ?? "",
    terms: input.terms ?? "",
    tagIds,
  });
  await doc.populate("tagIds", "name color");
  return toDTO(doc);
}

export async function updateQuotation(
  orgId: string,
  id: string,
  input: UpdateQuotationInput,
): Promise<QuotationDTO> {
  const doc = await findDoc(orgId, id);
  if (effectiveStatus(doc) !== "draft") {
    throw new AppError("CONFLICT", "Only draft quotations can be edited");
  }

  if (input.customerId) {
    const customer = await Customer.findOne({ _id: input.customerId, organizationId: orgId });
    if (!customer) throw new AppError("VALIDATION_ERROR", "Invalid customer selected");
    doc.customerId = customer._id;
    doc.customerName = customer.name;
    if (!input.currency) doc.currency = customer.currency ?? doc.currency;
  }
  if (input.issueDate) doc.issueDate = new Date(input.issueDate);
  if (input.expiryDate) doc.expiryDate = new Date(input.expiryDate);
  if (input.currency) doc.currency = input.currency;
  if (input.notes !== undefined) doc.notes = input.notes;
  if (input.terms !== undefined) doc.terms = input.terms;
  if (input.lineItems) {
    const { lineItems, totals } = buildLines(input.lineItems);
    doc.set({
      lineItems,
      subtotalMinor: totals.subtotalMinor,
      discountTotalMinor: totals.discountTotalMinor,
      taxTotalMinor: totals.taxTotalMinor,
      taxBreakdown: totals.taxBreakdown,
      totalMinor: totals.totalMinor,
    });
  }
  if (input.tagIds !== undefined) {
    doc.set("tagIds", await resolveTagIds(orgId, input.tagIds));
  }
  await doc.save();
  await doc.populate("tagIds", "name color");
  return toDTO(doc);
}

export async function deleteQuotation(orgId: string, id: string): Promise<void> {
  const doc = await findDoc(orgId, id);
  if (doc.convertedTo?.salesOrderId) {
    throw new AppError("CONFLICT", "This quotation was converted and cannot be deleted");
  }
  await doc.deleteOne();
}

// ── status transitions ──
export async function sendQuotation(orgId: string, id: string): Promise<QuotationDTO> {
  const doc = await findDoc(orgId, id);
  const eff = effectiveStatus(doc);
  if (eff === "accepted" || eff === "declined") {
    throw new AppError("CONFLICT", `Cannot send a ${eff} quotation`);
  }
  doc.status = "sent";
  doc.sentAt = new Date();
  await doc.save();
  return toDTO(doc);
}

export async function acceptQuotation(orgId: string, id: string): Promise<QuotationDTO> {
  const doc = await findDoc(orgId, id);
  if (doc.convertedTo?.salesOrderId) {
    throw new AppError("CONFLICT", "Quotation already converted");
  }
  doc.status = "accepted";
  doc.acceptedAt = new Date();
  await doc.save();
  return toDTO(doc);
}

export async function declineQuotation(orgId: string, id: string): Promise<QuotationDTO> {
  const doc = await findDoc(orgId, id);
  doc.status = "declined";
  doc.declinedAt = new Date();
  await doc.save();
  return toDTO(doc);
}

export async function convertQuotation(
  orgId: string,
  id: string,
  input: ConvertQuotationInput,
): Promise<{ quotation: QuotationDTO; salesOrder: SalesOrderDTO }> {
  const doc = await findDoc(orgId, id);
  if (effectiveStatus(doc) !== "accepted") {
    throw new AppError("CONFLICT", "Only accepted quotations can be converted");
  }
  if (doc.convertedTo?.salesOrderId) {
    throw new AppError("CONFLICT", "Quotation already converted to a sales order");
  }

  const so = await createFromQuote(orgId, doc, input.lines);
  doc.convertedTo = { salesOrderId: so._id };
  await doc.save();

  return { quotation: toDTO(doc), salesOrder: salesOrderToDTO(so) };
}

export async function convertToInvoice(
  orgId: string,
  id: string,
  userId: string,
): Promise<{ quotation: QuotationDTO; invoice: Pick<InvoiceDTO, "id" | "invoiceNumber"> }> {
  const doc = await findDoc(orgId, id);
  if (effectiveStatus(doc) !== "accepted") {
    throw new AppError("CONFLICT", "Only accepted quotations can be converted to an invoice");
  }
  if (doc.convertedTo?.invoiceId) {
    throw new AppError("CONFLICT", "Quotation already converted to an invoice");
  }

  const [salesperson, org] = await Promise.all([
    User.findOne({ _id: userId, organizationId: orgId }),
    Organization.findById(orgId),
  ]);
  if (!salesperson) throw new AppError("NOT_FOUND", "User not found");

  const rawLines = (doc.lineItems as { description: string; quantity: number; unitPriceMinor: number; discountPct?: number; taxPct?: number; taxes?: { code: string; rate: number }[] }[]).map(
    (l) => ({
      description: l.description,
      quantity: l.quantity,
      unitPriceMinor: l.unitPriceMinor,
      discountPct: l.discountPct ?? 0,
      taxes: l.taxes?.length
        ? l.taxes.map((t) => ({ code: t.code, rate: t.rate }))
        : l.taxPct && l.taxPct > 0
          ? [{ code: "VAT", rate: l.taxPct }]
          : [],
    }),
  );

  const computedLines = rawLines.map((l) => {
    const b = computeInvoiceLine(l);
    return { ...l, taxes: b.taxes, lineSubtotalMinor: b.lineSubtotalMinor, discountMinor: b.discountMinor, taxableMinor: b.taxableMinor, taxTotalMinor: b.taxTotalMinor, lineTotalMinor: b.lineTotalMinor };
  });
  const totals = sumInvoiceTotals(rawLines);

  const invoiceNumber = await nextNumber(orgId, "invoice", "IN-");
  const today = new Date();
  const dueDate = new Date(today);
  dueDate.setDate(dueDate.getDate() + 30);

  const branding = org?.branding
    ? {
        logoUrl: (org.branding as { logoUrl?: string }).logoUrl ?? "",
        primaryColor: (org.branding as { primaryColor?: string }).primaryColor ?? "",
        footerText: (org.branding as { footerText?: string }).footerText ?? "",
      }
    : {};

  const invoice = await Invoice.create({
    organizationId: new Types.ObjectId(orgId),
    invoiceNumber,
    customerId: doc.customerId,
    customerName: doc.customerName,
    salespersonId: salesperson._id,
    salespersonName: salesperson.name,
    reference: doc.quoteNumber,
    status: "draft",
    issueDate: today,
    dueDate,
    currency: doc.currency ?? "AED",
    lineItems: computedLines,
    subtotalMinor: totals.subtotalMinor,
    discountTotalMinor: totals.discountTotalMinor,
    taxBreakdown: totals.taxBreakdown,
    taxTotalMinor: totals.taxTotalMinor,
    totalMinor: totals.totalMinor,
    amountPaidMinor: 0,
    balanceMinor: totals.totalMinor,
    notes: doc.notes ?? "",
    terms: doc.terms ?? "",
    tagIds: doc.tagIds ?? [],
    branding,
    progress: null,
    recurring: null,
    sourceQuoteId: doc._id,
    payments: [],
  });

  doc.convertedTo = { ...(doc.convertedTo ?? {}), invoiceId: invoice._id };
  await doc.save();

  return {
    quotation: toDTO(doc),
    invoice: { id: invoice._id.toString(), invoiceNumber: invoice.invoiceNumber },
  };
}
