import { Types } from "mongoose";
import type {
  ConvertQuotationInput,
  ConvertToInvoiceInput,
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
    taxInclusive: (doc as unknown as { taxInclusive?: boolean }).taxInclusive ?? false,
    invoicedMinor: (doc as unknown as { invoicedMinor?: number }).invoicedMinor ?? 0,
    notes: doc.notes ?? "",
    terms: doc.terms ?? "",
    tags: toTagRefs(doc.tagIds),
    convertedTo: doc.convertedTo
      ? {
          salesOrderId: doc.convertedTo.salesOrderId?.toString(),
          invoiceId: doc.convertedTo.invoiceId?.toString(),
          invoiceIds: ((doc.convertedTo as unknown as { invoiceIds?: { toString(): string }[] }).invoiceIds ?? []).map((x) => x.toString()),
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

  const { lineItems, totals } = buildLines(input.lineItems, input.taxInclusive ?? false);
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
    taxInclusive: input.taxInclusive ?? false,
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
  if (input.taxInclusive !== undefined) doc.set("taxInclusive", input.taxInclusive);
  // Recompute when the lines change OR when only the tax-inclusive flag toggles
  // (the latter changes the totals even with the same lines).
  if (input.lineItems || input.taxInclusive !== undefined) {
    const effectiveInclusive = input.taxInclusive ?? (doc as unknown as { taxInclusive?: boolean }).taxInclusive ?? false;
    const rawLines = (input.lineItems ?? (doc.lineItems as unknown as Parameters<typeof buildLines>[0]));
    const { lineItems, totals } = buildLines(rawLines, effectiveInclusive);
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
  doc.convertedTo = {
    ...(doc.convertedTo ?? {}),
    salesOrderId: so._id,
    invoiceIds: (doc.convertedTo as unknown as { invoiceIds?: Types.ObjectId[] })?.invoiceIds ?? [],
  } as typeof doc.convertedTo;
  await doc.save();

  return { quotation: toDTO(doc), salesOrder: salesOrderToDTO(so) };
}

export async function convertToInvoice(
  orgId: string,
  id: string,
  userId: string,
  input: ConvertToInvoiceInput = { mode: "full" },
): Promise<{ quotation: QuotationDTO; invoice: Pick<InvoiceDTO, "id" | "invoiceNumber"> }> {
  const doc = await findDoc(orgId, id);
  if (effectiveStatus(doc) !== "accepted") {
    throw new AppError("CONFLICT", "Only accepted quotations can be converted to an invoice");
  }

  const quoteTotal = doc.totalMinor ?? 0;
  const quoteInclusive = (doc as unknown as { taxInclusive?: boolean }).taxInclusive ?? false;
  const alreadyInvoiced = (doc as unknown as { invoicedMinor?: number }).invoicedMinor ?? 0;
  const remaining = quoteTotal - alreadyInvoiced;
  if (quoteTotal <= 0) throw new AppError("VALIDATION_ERROR", "Quotation has no invoiceable amount");
  if (remaining <= 0) throw new AppError("CONFLICT", "Quotation is already fully invoiced");

  const [salesperson, org] = await Promise.all([
    User.findOne({ _id: userId, "memberships.organizationId": orgId }),
    Organization.findById(orgId),
  ]);
  if (!salesperson) throw new AppError("NOT_FOUND", "User not found");

  const baseLines = (doc.lineItems as { description: string; quantity: number; unitPriceMinor: number; discountPct?: number; taxPct?: number; taxes?: { code: string; rate: number }[]; itemId?: string }[]).map(
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
      itemId: l.itemId,
    }),
  );

  // Build the invoice's lines for the requested portion of the quote.
  let rawLines: typeof baseLines;
  // The invoice's own tax mode. Full-from-scratch keeps the quote's mode and
  // exact lines; every partial mode emits ex-tax lines, so it is exclusive.
  let invoiceInclusive = quoteInclusive;

  if (input.mode === "per_line") {
    const amounts = input.lineAmountsMinor ?? [];
    rawLines = baseLines
      .map((l, i) => ({ ...l, unitPriceMinor: amounts[i] ?? 0, quantity: 1, discountPct: 0 }))
      .filter((l) => l.unitPriceMinor > 0);
    if (rawLines.length === 0) throw new AppError("VALIDATION_ERROR", "Enter an amount for at least one line");
    invoiceInclusive = false; // per-line amounts are entered pre-tax
  } else if (input.mode === "full" && alreadyInvoiced === 0) {
    // Whole quote, exact line items and prices.
    rawLines = baseLines;
  } else {
    // percentage / amount / remaining-balance → a single, clearly-labelled portion
    // line so per-item unit prices are never silently rescaled on the invoice.
    let portion: number; // tax-inclusive amount to invoice
    let label: string;
    if (input.mode === "percentage") {
      const pct = input.percentage ?? 0;
      if (pct <= 0) throw new AppError("VALIDATION_ERROR", "Enter a percentage greater than 0");
      portion = Math.round((quoteTotal * pct) / 100);
      label = `${doc.quoteNumber} — ${pct}% partial invoice`;
    } else if (input.mode === "amount") {
      const amt = input.amountMinor ?? 0;
      if (amt <= 0) throw new AppError("VALIDATION_ERROR", "Enter an amount greater than 0");
      portion = amt;
      label = `${doc.quoteNumber} — partial invoice`;
    } else {
      portion = remaining; // "full" with some already invoiced → the remaining balance
      label = `${doc.quoteNumber} — balance`;
    }

    // Split the portion into an ex-tax base plus the quote's tax codes (blended by
    // the quote's overall effective rate) so the invoice keeps a tax breakdown.
    // Use the net taxable base (subtotal − discount) — that's what the quote's
    // tax was actually computed on — so discounted quotes split correctly.
    const quoteSubtotal = doc.subtotalMinor ?? 0;
    const quoteDiscount = (doc as unknown as { discountTotalMinor?: number }).discountTotalMinor ?? 0;
    const quoteTaxTotal = doc.taxTotalMinor ?? 0;
    const taxableBase = quoteSubtotal - quoteDiscount;
    const effRate = taxableBase > 0 ? quoteTaxTotal / taxableBase : 0;
    const exTax = Math.round(portion / (1 + effRate));
    const aggTaxes = ((doc.taxBreakdown ?? []) as { code: string; amountMinor: number }[]).map((b) => ({
      code: b.code,
      rate: taxableBase > 0 ? (b.amountMinor / taxableBase) * 100 : 0,
    }));
    rawLines = [{ description: label, quantity: 1, unitPriceMinor: exTax, discountPct: 0, taxes: aggTaxes, itemId: undefined }];
    invoiceInclusive = false; // portion already reduced to an ex-tax base
  }

  const computedLines = rawLines.map((l) => {
    const b = computeInvoiceLine({ ...l, taxInclusive: invoiceInclusive });
    return { ...l, taxes: b.taxes, lineSubtotalMinor: b.lineSubtotalMinor, discountMinor: b.discountMinor, taxableMinor: b.taxableMinor, taxTotalMinor: b.taxTotalMinor, lineTotalMinor: b.lineTotalMinor };
  });
  const totals = sumInvoiceTotals(rawLines.map((l) => ({ ...l, taxInclusive: invoiceInclusive })));

  // Never invoice beyond the remaining balance (small tolerance for rounding).
  if (totals.totalMinor > remaining + 2) {
    throw new AppError("CONFLICT", "The amount to invoice exceeds the quotation's remaining balance");
  }
  if (totals.totalMinor <= 0) {
    throw new AppError("VALIDATION_ERROR", "The amount to invoice must be greater than 0");
  }

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
    taxInclusive: invoiceInclusive,
    sourceQuoteId: doc._id,
    payments: [],
  });

  (doc as unknown as { invoicedMinor: number }).invoicedMinor = alreadyInvoiced + totals.totalMinor;
  const prevIds = ((doc.convertedTo as unknown as { invoiceIds?: Types.ObjectId[] })?.invoiceIds) ?? [];
  doc.convertedTo = {
    ...(doc.convertedTo ?? {}),
    invoiceId: invoice._id,
    invoiceIds: [...prevIds, invoice._id],
  } as typeof doc.convertedTo;
  await doc.save();

  return {
    quotation: toDTO(doc),
    invoice: { id: invoice._id.toString(), invoiceNumber: invoice.invoiceNumber },
  };
}
