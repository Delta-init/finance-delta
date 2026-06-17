import { Types } from "mongoose";
import {
  computeInvoiceLine,
  sumInvoiceTotals,
  type CreateInvoiceInput,
  type Invoice as InvoiceDTO,
  type InvoiceQuery,
  type InvoiceStatus,
  type Paginated,
  type RecordPaymentInput,
  type UpdateInvoiceInput,
} from "@delta/shared";
import { AppError } from "../../lib/http";
import { buildSort, pageMeta, searchOr, skipFor } from "../../lib/paginate";
import { resolveTagIds, toTagRefs } from "../../lib/tags";
import { nextNumber } from "../sequence/sequence.service";
import { Customer } from "../customer/customer.model";
import { User } from "../user/user.model";
import { Organization } from "../organization/organization.model";
import { Invoice, type InvoiceDoc } from "./invoice.model";
import { sendInvoiceEmail } from "../../lib/email";
import { getExchangeRate } from "../../lib/exchange-rate";
import { scheduleReminders, cancelReminders } from "../../jobs/reminder.worker";
import { formatMoney } from "@delta/shared";

/** Lazily compute overdue: sent/viewed past due date with unpaid balance. */
function effectiveStatus(doc: InvoiceDoc): InvoiceStatus {
  const stored = doc.status as InvoiceStatus;
  if (
    (stored === "sent" || stored === "viewed" || stored === "partial") &&
    doc.dueDate &&
    doc.dueDate.getTime() < Date.now() &&
    (doc.amountPaidMinor ?? 0) < (doc.totalMinor ?? 0)
  ) {
    return "overdue";
  }
  return stored;
}

const dateOnly = (d: Date) => d.toISOString().slice(0, 10);

function toDTO(doc: InvoiceDoc): InvoiceDTO {
  return {
    id: doc._id.toString(),
    invoiceNumber: doc.invoiceNumber,
    customerId: doc.customerId.toString(),
    customerName: doc.customerName,
    salespersonId: doc.salespersonId.toString(),
    salespersonName: doc.salespersonName,
    reference: doc.reference ?? "",
    status: effectiveStatus(doc),
    issueDate: dateOnly(doc.issueDate),
    dueDate: dateOnly(doc.dueDate),
    currency: doc.currency ?? "AED",
    lineItems: doc.lineItems as InvoiceDTO["lineItems"],
    subtotalMinor: doc.subtotalMinor ?? 0,
    discountTotalMinor: doc.discountTotalMinor ?? 0,
    taxBreakdown: (doc.taxBreakdown as { code: string; amountMinor: number }[]) ?? [],
    taxTotalMinor: doc.taxTotalMinor ?? 0,
    totalMinor: doc.totalMinor ?? 0,
    amountPaidMinor: doc.amountPaidMinor ?? 0,
    balanceMinor: doc.balanceMinor ?? 0,
    notes: doc.notes ?? "",
    terms: doc.terms ?? "",
    tags: toTagRefs(doc.tagIds),
    branding: doc.branding as InvoiceDTO["branding"],
    progress: doc.progress as InvoiceDTO["progress"] ?? null,
    recurring: doc.recurring
      ? {
          frequency: doc.recurring.frequency as "weekly" | "monthly" | "annually",
          startDate: dateOnly(doc.recurring.startDate),
          endDate: doc.recurring.endDate ? dateOnly(doc.recurring.endDate) : undefined,
          nextRunAt: dateOnly(doc.recurring.nextRunAt),
          isActive: doc.recurring.isActive ?? true,
        }
      : null,
    payments: ((doc.payments as unknown[]) ?? []).map((p) => {
      const pm = p as {
        _id: { toString(): string };
        method: string;
        amountMinor: number;
        paidOn: Date;
        reference: string;
        notes: string;
        createdAt: Date;
      };
      return {
        id: pm._id.toString(),
        method: pm.method as InvoiceDTO["payments"][0]["method"],
        amountMinor: pm.amountMinor,
        paidOn: dateOnly(pm.paidOn),
        reference: pm.reference ?? "",
        notes: pm.notes ?? "",
        accountName: (pm as unknown as { accountName?: string }).accountName ?? "",
        createdAt: pm.createdAt.toISOString(),
      };
    }),
    sourceQuoteId: doc.sourceQuoteId?.toString(),
    locale: (doc as unknown as { locale?: string }).locale ?? "en",
    exchangeRate: (doc as unknown as { exchangeRate?: number }).exchangeRate ?? 1,
    createdAt: doc.createdAt.toISOString(),
  };
}

function buildLines(raw: CreateInvoiceInput["lineItems"]) {
  const lineItems = raw.map((l) => {
    const b = computeInvoiceLine(l);
    return {
      description: l.description,
      quantity: l.quantity,
      unitPriceMinor: l.unitPriceMinor,
      discountPct: l.discountPct ?? 0,
      taxes: b.taxes,
      lineSubtotalMinor: b.lineSubtotalMinor,
      discountMinor: b.discountMinor,
      taxableMinor: b.taxableMinor,
      taxTotalMinor: b.taxTotalMinor,
      lineTotalMinor: b.lineTotalMinor,
    };
  });
  const totals = sumInvoiceTotals(raw);
  return { lineItems, totals };
}

async function findDoc(orgId: string, id: string) {
  const doc = await Invoice.findOne({ _id: id, organizationId: orgId });
  if (!doc) throw new AppError("NOT_FOUND", "Invoice not found");
  return doc;
}

const SORT = {
  number: "invoiceNumber",
  customer: "customerName",
  salesperson: "salespersonName",
  issue: "issueDate",
  due: "dueDate",
  status: "status",
  total: "totalMinor",
  createdAt: "createdAt",
} as const;

export async function listInvoices(
  orgId: string,
  query: InvoiceQuery,
): Promise<Paginated<InvoiceDTO>> {
  const now = new Date();
  const and: Record<string, unknown>[] = [];
  const or = searchOr(query.q, ["invoiceNumber", "customerName", "salespersonName", "reference"]);
  if (or) and.push({ $or: or });

  if (query.status === "overdue") {
    and.push({ status: { $in: ["sent", "viewed", "partial"] }, dueDate: { $lt: now } });
  } else if (query.status) {
    and.push({ status: query.status });
  }

  if (query.salespersonId) and.push({ salespersonId: new Types.ObjectId(query.salespersonId) });
  if (query.issueFrom) and.push({ issueDate: { $gte: new Date(query.issueFrom) } });
  if (query.issueTo) and.push({ issueDate: { $lte: new Date(query.issueTo) } });
  if (query.dueFrom) and.push({ dueDate: { $gte: new Date(query.dueFrom) } });
  if (query.dueTo) and.push({ dueDate: { $lte: new Date(query.dueTo) } });
  if (query.tagIds?.length) and.push({ tagIds: { $in: query.tagIds } });

  const filter: Record<string, unknown> = { organizationId: orgId };
  if (and.length) filter.$and = and;

  const sort = buildSort(SORT, query.sort, query.dir);
  const [rows, total] = await Promise.all([
    Invoice.find(filter)
      .populate("tagIds", "name color")
      .sort(sort)
      .skip(skipFor(query.page, query.pageSize))
      .limit(query.pageSize),
    Invoice.countDocuments(filter),
  ]);
  return {
    data: rows.map((r) => toDTO(r as unknown as InvoiceDoc)),
    meta: pageMeta(total, query.page, query.pageSize),
  };
}

export async function getInvoice(orgId: string, id: string): Promise<InvoiceDTO> {
  const doc = await Invoice.findOne({ _id: id, organizationId: orgId }).populate(
    "tagIds",
    "name color",
  );
  if (!doc) throw new AppError("NOT_FOUND", "Invoice not found");
  return toDTO(doc as unknown as InvoiceDoc);
}

export async function createInvoice(
  orgId: string,
  input: CreateInvoiceInput,
): Promise<InvoiceDTO> {
  const [customer, salesperson, org] = await Promise.all([
    Customer.findOne({ _id: input.customerId, organizationId: orgId }),
    User.findOne({ _id: input.salespersonId, organizationId: orgId }),
    Organization.findById(orgId),
  ]);
  if (!customer) throw new AppError("VALIDATION_ERROR", "Invalid customer selected");
  if (!salesperson) throw new AppError("VALIDATION_ERROR", "Invalid salesperson selected");

  const { lineItems, totals } = buildLines(input.lineItems);
  const invoiceNumber = await nextNumber(orgId, "invoice", "IN-");
  const tagIds = await resolveTagIds(orgId, input.tagIds);

  const branding = org?.branding
    ? {
        logoUrl: (org.branding as { logoUrl?: string }).logoUrl ?? "",
        primaryColor: (org.branding as { primaryColor?: string }).primaryColor ?? "",
        footerText: (org.branding as { footerText?: string }).footerText ?? "",
      }
    : {};

  const recurring = input.recurring
    ? {
        frequency: input.recurring.frequency,
        startDate: new Date(input.recurring.startDate),
        endDate: input.recurring.endDate ? new Date(input.recurring.endDate) : undefined,
        nextRunAt: new Date(input.recurring.startDate),
        isActive: input.recurring.isActive ?? true,
      }
    : null;

  const doc = await Invoice.create({
    organizationId: new Types.ObjectId(orgId),
    invoiceNumber,
    customerId: customer._id,
    customerName: customer.name,
    salespersonId: salesperson._id,
    salespersonName: salesperson.name,
    reference: input.reference ?? "",
    status: "draft",
    issueDate: new Date(input.issueDate),
    dueDate: new Date(input.dueDate),
    currency: input.currency ?? customer.currency ?? "AED",
    lineItems,
    subtotalMinor: totals.subtotalMinor,
    discountTotalMinor: totals.discountTotalMinor,
    taxBreakdown: totals.taxBreakdown,
    taxTotalMinor: totals.taxTotalMinor,
    totalMinor: totals.totalMinor,
    amountPaidMinor: 0,
    balanceMinor: totals.totalMinor,
    notes: input.notes ?? "",
    terms: input.terms ?? "",
    tagIds,
    branding,
    progress: input.progress ?? null,
    recurring,
    locale: input.locale ?? "en",
    exchangeRate: input.exchangeRate ?? (await getExchangeRate(org?.baseCurrency ?? "AED", input.currency ?? customer.currency ?? "AED")),
  });
  await doc.populate("tagIds", "name color");
  return toDTO(doc);
}

export async function updateInvoice(
  orgId: string,
  id: string,
  input: UpdateInvoiceInput,
): Promise<InvoiceDTO> {
  const doc = await findDoc(orgId, id);
  if (effectiveStatus(doc) !== "draft") {
    throw new AppError("CONFLICT", "Only draft invoices can be edited");
  }

  if (input.customerId) {
    const customer = await Customer.findOne({ _id: input.customerId, organizationId: orgId });
    if (!customer) throw new AppError("VALIDATION_ERROR", "Invalid customer selected");
    doc.customerId = customer._id;
    doc.customerName = customer.name;
  }
  if (input.salespersonId) {
    const salesperson = await User.findOne({ _id: input.salespersonId, organizationId: orgId });
    if (!salesperson) throw new AppError("VALIDATION_ERROR", "Invalid salesperson selected");
    doc.salespersonId = salesperson._id;
    doc.salespersonName = salesperson.name;
  }
  if (input.reference !== undefined) doc.reference = input.reference;
  if (input.issueDate) doc.issueDate = new Date(input.issueDate);
  if (input.dueDate) doc.dueDate = new Date(input.dueDate);
  if (input.currency) doc.currency = input.currency;
  if (input.notes !== undefined) doc.notes = input.notes;
  if (input.terms !== undefined) doc.terms = input.terms;
  if (input.progress !== undefined) doc.set("progress", input.progress ?? null);
  if (input.recurring !== undefined) {
    if (!input.recurring) {
      doc.set("recurring", null);
    } else {
      doc.set("recurring", {
        frequency: input.recurring.frequency,
        startDate: input.recurring.startDate ? new Date(input.recurring.startDate) : doc.recurring?.startDate,
        endDate: input.recurring.endDate ? new Date(input.recurring.endDate) : undefined,
        nextRunAt: input.recurring.startDate ? new Date(input.recurring.startDate) : doc.recurring?.nextRunAt,
        isActive: input.recurring.isActive ?? true,
      });
    }
  }
  if (input.lineItems) {
    const { lineItems, totals } = buildLines(input.lineItems);
    doc.set({
      lineItems,
      subtotalMinor: totals.subtotalMinor,
      discountTotalMinor: totals.discountTotalMinor,
      taxBreakdown: totals.taxBreakdown,
      taxTotalMinor: totals.taxTotalMinor,
      totalMinor: totals.totalMinor,
      balanceMinor: totals.totalMinor - (doc.amountPaidMinor ?? 0),
    });
  }
  if (input.tagIds !== undefined) {
    doc.set("tagIds", await resolveTagIds(orgId, input.tagIds));
  }
  await doc.save();
  await doc.populate("tagIds", "name color");
  return toDTO(doc);
}

export async function deleteInvoice(orgId: string, id: string): Promise<void> {
  const doc = await findDoc(orgId, id);
  if (effectiveStatus(doc) !== "draft") {
    throw new AppError("CONFLICT", "Only draft invoices can be deleted");
  }
  await doc.deleteOne();
}

export async function sendInvoice(orgId: string, id: string): Promise<InvoiceDTO> {
  const doc = await findDoc(orgId, id);
  const eff = effectiveStatus(doc);
  if (eff !== "draft") throw new AppError("CONFLICT", `Cannot send a ${eff} invoice`);
  doc.status = "sent";
  doc.sentAt = new Date();
  await doc.save();
  void _dispatchInvoiceEmail(orgId, doc, undefined);
  return toDTO(doc);
}

export async function resendInvoice(orgId: string, id: string, message?: string): Promise<void> {
  const doc = await findDoc(orgId, id);
  void _dispatchInvoiceEmail(orgId, doc, message);
}

async function _dispatchInvoiceEmail(orgId: string, doc: InvoiceDoc, message?: string) {
  try {
    const [customer, org] = await Promise.all([
      Customer.findById(doc.customerId),
      Organization.findById(orgId),
    ]);
    if (!customer?.email) return;
    const orgName = org?.name ?? "Delta Finance";
    const footerText = (org?.branding as { footerText?: string })?.footerText ?? "";
    const totalFormatted = formatMoney(doc.totalMinor ?? 0, doc.currency ?? "AED");
    const { id: emailId } = await sendInvoiceEmail({
      to: customer.email,
      orgName,
      invoiceNumber: doc.invoiceNumber,
      customerName: doc.customerName,
      totalFormatted,
      dueDate: dateOnly(doc.dueDate),
      footerText,
      message,
    });
    if (emailId) {
      await Invoice.findByIdAndUpdate(doc._id, { $set: { lastEmailId: emailId } });
    }
    const intervals: number[] = (org as unknown as { reminderIntervals?: number[] })?.reminderIntervals ?? [-3, 1, 7];
    await scheduleReminders({
      invoiceId: String(doc._id),
      orgId,
      orgName,
      footerText,
      customerEmail: customer.email,
      customerName: doc.customerName,
      invoiceNumber: doc.invoiceNumber,
      totalFormatted,
      dueDate: dateOnly(doc.dueDate),
      intervals,
    });
  } catch (err) {
    // non-fatal — email failure must not block the send action
    const { logger } = await import("../../lib/logger");
    logger.error({ err }, "Invoice email dispatch failed");
  }
}

export async function voidInvoice(orgId: string, id: string): Promise<InvoiceDTO> {
  const doc = await findDoc(orgId, id);
  if ((doc.status as string) === "paid") {
    throw new AppError("CONFLICT", "Paid invoices cannot be voided");
  }
  if ((doc.status as string) === "void") {
    throw new AppError("CONFLICT", "Invoice is already voided");
  }
  doc.status = "void";
  await doc.save();
  return toDTO(doc);
}

export async function recordPayment(
  orgId: string,
  id: string,
  input: RecordPaymentInput,
): Promise<InvoiceDTO> {
  const doc = await findDoc(orgId, id);
  const eff = effectiveStatus(doc);
  if (eff === "void") throw new AppError("CONFLICT", "Cannot record payment on a voided invoice");
  if (eff === "paid") throw new AppError("CONFLICT", "Invoice is already fully paid");

  const currentBalance = doc.balanceMinor ?? 0;
  if (input.amountMinor > currentBalance) {
    throw new AppError("CONFLICT", `Payment of ${input.amountMinor} exceeds balance of ${currentBalance}`);
  }

  const payment = {
    method: input.method,
    amountMinor: input.amountMinor,
    paidOn: new Date(input.paidOn),
    reference: input.reference ?? "",
    notes: input.notes ?? "",
    accountName: input.accountName ?? "",
  };

  (doc.payments as unknown[]).push(payment);
  const newPaid = (doc.amountPaidMinor ?? 0) + input.amountMinor;
  const newBalance = (doc.totalMinor ?? 0) - newPaid;
  doc.amountPaidMinor = newPaid;
  doc.balanceMinor = newBalance;
  doc.status = newBalance <= 0 ? "paid" : "partial";

  await doc.save();
  await doc.populate("tagIds", "name color");

  if (newBalance <= 0) {
    const org = await Organization.findById(orgId);
    const intervals: number[] = (org as unknown as { reminderIntervals?: number[] })?.reminderIntervals ?? [-3, 1, 7];
    void cancelReminders(id, intervals);
  }

  return toDTO(doc);
}
