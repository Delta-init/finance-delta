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
import { assertOwned, scopeFilter, type Scope } from "../../lib/ownership";
import {
  notifyApproversOfEnrolment,
  notifyEnrolmentDecided,
} from "./enrolment-notify.service";
import { buildSort, pageMeta, searchOr, skipFor } from "../../lib/paginate";
import { resolveTagIds, toTagRefs } from "../../lib/tags";
import { nextNumber } from "../sequence/sequence.service";
import { invoiceNumberingFor } from "../organization/organization.service";
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
    enrolment: doc.enrolment
      ? {
          course: doc.enrolment.course,
          modeOfStudy: doc.enrolment.modeOfStudy,
          language: doc.enrolment.language,
          meetingBy: doc.enrolment.meetingBy ?? "",
          declaredPaidMinor: doc.enrolment.declaredPaidMinor ?? 0,
          declaredPaymentMethod: doc.enrolment.declaredPaymentMethod ?? undefined,
          approval: doc.enrolment.approval,
          approvedById: doc.enrolment.approvedById ? String(doc.enrolment.approvedById) : undefined,
          approvedByName: doc.enrolment.approvedByName ?? undefined,
          approvedAt: doc.enrolment.approvedAt ? new Date(doc.enrolment.approvedAt).toISOString() : undefined,
          returnedReason: doc.enrolment.returnedReason ?? undefined,
          submittedAt: doc.enrolment.submittedAt ? new Date(doc.enrolment.submittedAt).toISOString() : undefined,
        }
      : undefined,
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
        accountName?: string;
        chargesMinor?: number;
        emi?: {
          bank?: string;
          tenureMonths?: number;
          monthlyAmountMinor?: number;
          interestPct?: number;
          processingFeeMinor?: number;
          transactionId?: string;
        };
        proofUrl?: string;
        proofKey?: string;
        createdAt: Date;
      };
      return {
        id: pm._id.toString(),
        method: pm.method as InvoiceDTO["payments"][0]["method"],
        amountMinor: pm.amountMinor,
        paidOn: dateOnly(pm.paidOn),
        reference: pm.reference ?? "",
        notes: pm.notes ?? "",
        accountName: pm.accountName ?? "",
        chargesMinor: pm.chargesMinor ?? 0,
        emi: pm.emi
          ? {
              bank: pm.emi.bank ?? "",
              tenureMonths: pm.emi.tenureMonths ?? 0,
              monthlyAmountMinor: pm.emi.monthlyAmountMinor ?? 0,
              interestPct: pm.emi.interestPct ?? 0,
              processingFeeMinor: pm.emi.processingFeeMinor ?? 0,
              transactionId: pm.emi.transactionId ?? "",
            }
          : undefined,
        proofUrl: pm.proofUrl || undefined,
        createdAt: pm.createdAt.toISOString(),
      };
    }),
    sourceQuoteId: doc.sourceQuoteId?.toString(),
    locale: (doc as unknown as { locale?: string }).locale ?? "en",
    exchangeRate: (doc as unknown as { exchangeRate?: number }).exchangeRate ?? 1,
    taxInclusive: (doc as unknown as { taxInclusive?: boolean }).taxInclusive ?? false,
    createdAt: doc.createdAt.toISOString(),
  };
}

function buildLines(raw: CreateInvoiceInput["lineItems"], taxInclusive = false) {
  const lineItems = raw.map((l) => {
    const b = computeInvoiceLine({ ...l, taxInclusive });
    return {
      description: l.description,
      quantity: l.quantity,
      unitPriceMinor: l.unitPriceMinor,
      discountPct: l.discountPct ?? 0,
      itemId: l.itemId,
      warehouseId: l.warehouseId,
      taxes: b.taxes,
      lineSubtotalMinor: b.lineSubtotalMinor,
      discountMinor: b.discountMinor,
      taxableMinor: b.taxableMinor,
      taxTotalMinor: b.taxTotalMinor,
      lineTotalMinor: b.lineTotalMinor,
    };
  });
  const totals = sumInvoiceTotals(raw.map((l) => ({ ...l, taxInclusive })));
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
  scope: Scope,
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

  // Not taken from `query`: asking for another salesperson's invoices must
  // narrow the result to nothing, never widen it.
  const filter: Record<string, unknown> = {
    organizationId: orgId,
    ...scopeFilter(scope, "salespersonId"),
  };
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

export async function getInvoice(orgId: string, id: string, scope: Scope): Promise<InvoiceDTO> {
  const doc = await Invoice.findOne({ _id: id, organizationId: orgId }).populate(
    "tagIds",
    "name color",
  );
  if (!doc) throw new AppError("NOT_FOUND", "Invoice not found");
  assertOwned(scope, doc.salespersonId, "Invoice");
  return toDTO(doc as unknown as InvoiceDoc);
}

export async function createInvoice(
  orgId: string,
  input: CreateInvoiceInput,
  scope: Scope,
): Promise<InvoiceDTO> {
  // The salesperson arrives in the body, so somebody raising their own
  // invoices could otherwise put another name on one — and then not even see
  // it afterwards, since it would not be theirs.
  const salespersonId = scope.all ? input.salespersonId : scope.userId;

  const [customer, salesperson, org] = await Promise.all([
    Customer.findOne({ _id: input.customerId, organizationId: orgId }),
    User.findOne({ _id: salespersonId, "memberships.organizationId": orgId }),
    Organization.findById(orgId),
  ]);
  if (!customer) throw new AppError("VALIDATION_ERROR", "Invalid customer selected");
  if (!salesperson) throw new AppError("VALIDATION_ERROR", "Invalid salesperson selected");

  // An enrolment starts unapproved, whoever raised it. An administrator
  // creating one still has it go through the same gate — the point is that the
  // figures were checked, not who typed them.
  const enrolment = input.enrolment
    ? { ...input.enrolment, approval: "pending" as const, submittedAt: new Date() }
    : undefined;

  const { lineItems, totals } = buildLines(input.lineItems, input.taxInclusive ?? false);
  const numbering = await invoiceNumberingFor(orgId);
  const invoiceNumber = await nextNumber(orgId, "invoice", numbering.prefix, numbering.pad);
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
    ...(enrolment ? { enrolment } : {}),
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
    taxInclusive: input.taxInclusive ?? false,
  });
  await doc.populate("tagIds", "name color");
  // An enrolment goes straight into the approval queue. Not awaited: the
  // invoice exists either way, and a mail outage must not fail the creation.
  if (enrolment) void notifyApproversOfEnrolment(doc as unknown as InvoiceDoc);
  return toDTO(doc);
}

export async function updateInvoice(
  orgId: string,
  id: string,
  input: UpdateInvoiceInput,
  scope: Scope,
): Promise<InvoiceDTO> {
  const doc = await findDoc(orgId, id);
  assertOwned(scope, doc.salespersonId, "Invoice");
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
    const salesperson = await User.findOne({ _id: input.salespersonId, "memberships.organizationId": orgId });
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
  if (input.taxInclusive !== undefined) doc.set("taxInclusive", input.taxInclusive);
  if (input.lineItems) {
    const effectiveTaxInclusive = input.taxInclusive ?? (doc as unknown as { taxInclusive?: boolean }).taxInclusive ?? false;
    const { lineItems, totals } = buildLines(input.lineItems, effectiveTaxInclusive);
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

/**
 * An enrolment cannot reach the client, or be paid, until somebody has checked it.
 *
 * Only applies where there is an enrolment. An invoice raised by accounts has
 * none and passes straight through, which is what keeps this from landing a
 * backlog of existing drafts in front of an approver.
 */

/**
 * Approve an enrolment, which is what lets its invoice be sent and paid.
 *
 * Recorded against a name and a time. The counsellor who raised it cannot do
 * this — the route is behind `invoice:write`, which they do not have.
 */
export async function approveEnrolment(
  orgId: string,
  id: string,
  actor: { userId: string; name: string },
): Promise<InvoiceDTO> {
  const doc = await findDoc(orgId, id);
  if (!doc.enrolment) throw new AppError("CONFLICT", "This invoice is not an enrolment");
  if (doc.enrolment.approval === "approved") {
    throw new AppError("CONFLICT", "This enrolment is already approved");
  }

  const e = doc.enrolment as unknown as Record<string, unknown>;
  e.approval = "approved";
  e.approvedById = new Types.ObjectId(actor.userId);
  e.approvedByName = actor.name;
  e.approvedAt = new Date();
  // Cleared, because it has been acted on. Leaving it would read as a standing
  // objection to something that has since been approved.
  e.returnedReason = undefined;
  await doc.save();

  void notifyEnrolmentDecided(doc, actor.name, "approved");
  return toDTO(doc as unknown as InvoiceDoc);
}

/** Send an enrolment back to whoever raised it, with a reason they can act on. */
export async function returnEnrolment(
  orgId: string,
  id: string,
  reason: string,
  actor: { userId: string; name: string },
): Promise<InvoiceDTO> {
  const doc = await findDoc(orgId, id);
  if (!doc.enrolment) throw new AppError("CONFLICT", "This invoice is not an enrolment");
  if (effectiveStatus(doc) !== "draft") {
    throw new AppError("CONFLICT", "Only an unsent enrolment can be sent back");
  }

  const e = doc.enrolment as unknown as Record<string, unknown>;
  e.approval = "returned";
  e.returnedReason = reason;
  e.approvedById = new Types.ObjectId(actor.userId);
  e.approvedByName = actor.name;
  e.approvedAt = new Date();
  await doc.save();

  void notifyEnrolmentDecided(doc, actor.name, "returned", reason);
  return toDTO(doc as unknown as InvoiceDoc);
}

/**
 * Put a corrected enrolment back in front of an approver.
 *
 * The counsellor's own action, so it is the one transition they may make.
 */
export async function resubmitEnrolment(
  orgId: string,
  id: string,
  scope: Scope,
): Promise<InvoiceDTO> {
  const doc = await findDoc(orgId, id);
  assertOwned(scope, doc.salespersonId, "Invoice");
  if (!doc.enrolment) throw new AppError("CONFLICT", "This invoice is not an enrolment");
  if (doc.enrolment.approval !== "returned") {
    throw new AppError("CONFLICT", "Only an enrolment that was sent back can be submitted again");
  }

  const e = doc.enrolment as unknown as Record<string, unknown>;
  e.approval = "pending";
  e.submittedAt = new Date();
  await doc.save();

  void notifyApproversOfEnrolment(doc as unknown as InvoiceDoc);
  return toDTO(doc as unknown as InvoiceDoc);
}

function assertEnrolmentApproved(doc: {
  enrolment?: { approval?: string | null; returnedReason?: string | null } | null;
}): void {
  const e = doc.enrolment;
  if (!e) return;
  if (e.approval === "approved") return;
  throw new AppError(
    "CONFLICT",
    e.approval === "returned"
      ? `This enrolment was sent back and needs correcting first${e.returnedReason ? `: ${e.returnedReason}` : ""}.`
      : "This enrolment is waiting for approval.",
  );
}

export async function sendInvoice(orgId: string, id: string, scope: Scope): Promise<InvoiceDTO> {
  const doc = await findDoc(orgId, id);
  assertOwned(scope, doc.salespersonId, "Invoice");
  const eff = effectiveStatus(doc);
  if (eff !== "draft") throw new AppError("CONFLICT", `Cannot send a ${eff} invoice`);
  assertEnrolmentApproved(doc);

  // Reject the send up front if any tracked line would oversell (drive stock
  // negative). Done synchronously so the client gets a 409 and nothing changes.
  const stockLines = (doc.lineItems as unknown as { itemId?: string; warehouseId?: string; quantity: number; description: string }[]) ?? [];
  const { assertStockAvailableForInvoice } = await import("../inventory/inventory.service");
  await assertStockAvailableForInvoice(orgId, stockLines);

  doc.status = "sent";
  doc.sentAt = new Date();
  await doc.save();
  void _dispatchInvoiceEmail(orgId, doc, undefined);
  void _deductInventory(orgId, doc);
  return toDTO(doc);
}

async function _deductInventory(orgId: string, doc: InvoiceDoc) {
  try {
    const { deductStockForInvoice } = await import("../inventory/inventory.service");
    const lines = (doc.lineItems as unknown as { itemId?: string; warehouseId?: string; quantity: number; description: string }[]) ?? [];
    await deductStockForInvoice(orgId, String(doc._id), doc.invoiceNumber, lines, doc.customerName ?? "");
  } catch (err) {
    const { logger } = await import("../../lib/logger");
    logger.error({ err }, "Inventory deduction failed for invoice");
  }
}

export async function resendInvoice(
  orgId: string,
  id: string,
  scope: Scope,
  message?: string,
): Promise<void> {
  const doc = await findDoc(orgId, id);
  assertOwned(scope, doc.salespersonId, "Invoice");
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
    // The organization's own logo where it has set one; the email template
    // falls back to Delta's otherwise.
    const logoUrl = (org?.branding as { logoUrl?: string })?.logoUrl ?? "";
    const totalFormatted = formatMoney(doc.totalMinor ?? 0, doc.currency ?? "AED");
    const { id: emailId } = await sendInvoiceEmail({
      to: customer.email,
      orgName,
      invoiceNumber: doc.invoiceNumber,
      customerName: doc.customerName,
      totalFormatted,
      dueDate: dateOnly(doc.dueDate),
      footerText,
      logoUrl,
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
  const wasSent = ["sent", "viewed", "partial"].includes(doc.status as string);
  doc.status = "void";
  await doc.save();
  if (wasSent) void _restoreInventory(orgId, doc);
  return toDTO(doc);
}

export async function updatePayment(
  orgId: string,
  id: string,
  paymentId: string,
  input: RecordPaymentInput,
): Promise<InvoiceDTO> {
  const doc = await findDoc(orgId, id);
  if (effectiveStatus(doc) === "void") throw new AppError("CONFLICT", "Cannot edit a payment on a voided invoice");

  const list = doc.payments as unknown as {
    id: (pid: string) => (Record<string, unknown>) | null;
  } & { amountMinor: number; _id: { toString(): string } }[];
  const pm = list.id(paymentId);
  if (!pm) throw new AppError("NOT_FOUND", "Payment not found");

  if (input.method === "easebuzz_emi" && (!input.emi || !input.emi.tenureMonths)) {
    throw new AppError("VALIDATION_ERROR", "EMI tenure is required for Easebuzz EMI payments");
  }

  // Total paid with this payment's amount swapped in — must not exceed the invoice total.
  const others = (doc.payments as unknown as { amountMinor: number; _id: { toString(): string } }[])
    .filter((p) => p._id.toString() !== paymentId)
    .reduce((s, p) => s + (p.amountMinor ?? 0), 0);
  const newPaid = others + input.amountMinor;
  if (newPaid > (doc.totalMinor ?? 0)) {
    throw new AppError("CONFLICT", `Total payments would exceed the invoice total of ${doc.totalMinor ?? 0}`);
  }

  const p = pm as Record<string, unknown>;
  p.method = input.method;
  p.amountMinor = input.amountMinor;
  p.paidOn = new Date(input.paidOn);
  p.reference = input.reference ?? "";
  p.notes = input.notes ?? "";
  p.accountName = input.accountName ?? "";
  p.chargesMinor = input.chargesMinor ?? 0;
  p.emi =
    input.method === "easebuzz_emi" && input.emi
      ? {
          bank: input.emi.bank ?? "",
          tenureMonths: input.emi.tenureMonths,
          monthlyAmountMinor: input.emi.monthlyAmountMinor ?? 0,
          interestPct: input.emi.interestPct ?? 0,
          processingFeeMinor: input.emi.processingFeeMinor ?? 0,
          transactionId: input.emi.transactionId ?? "",
        }
      : undefined;

  doc.amountPaidMinor = newPaid;
  doc.balanceMinor = (doc.totalMinor ?? 0) - newPaid;
  doc.status = doc.balanceMinor <= 0 ? "paid" : "partial";

  await doc.save();
  await doc.populate("tagIds", "name color");

  if (doc.balanceMinor <= 0) {
    const org = await Organization.findById(orgId);
    const intervals: number[] = (org as unknown as { reminderIntervals?: number[] })?.reminderIntervals ?? [-3, 1, 7];
    void cancelReminders(id, intervals);
  }

  return toDTO(doc);
}

async function _restoreInventory(orgId: string, doc: InvoiceDoc) {
  try {
    const { restoreStockForInvoice } = await import("../inventory/inventory.service");
    const lines = (doc.lineItems as unknown as { itemId?: string; warehouseId?: string; quantity: number; description: string }[]) ?? [];
    await restoreStockForInvoice(orgId, String(doc._id), doc.invoiceNumber, lines, "system");
  } catch (err) {
    const { logger } = await import("../../lib/logger");
    logger.error({ err }, "Inventory restore failed for voided invoice");
  }
}

export async function recordPayment(
  orgId: string,
  id: string,
  input: RecordPaymentInput,
  file?: { buffer: Buffer; mimeType: string; originalName: string },
): Promise<InvoiceDTO> {
  const doc = await findDoc(orgId, id);
  const eff = effectiveStatus(doc);
  if (eff === "void") throw new AppError("CONFLICT", "Cannot record payment on a voided invoice");
  if (eff === "paid") throw new AppError("CONFLICT", "Invoice is already fully paid");
  // Money is not recorded against something nobody has checked.
  assertEnrolmentApproved(doc);

  const currentBalance = doc.balanceMinor ?? 0;
  if (input.amountMinor > currentBalance) {
    throw new AppError("CONFLICT", `Payment of ${input.amountMinor} exceeds balance of ${currentBalance}`);
  }

  if (input.method === "easebuzz_emi" && (!input.emi || !input.emi.tenureMonths)) {
    throw new AppError("VALIDATION_ERROR", "EMI tenure is required for Easebuzz EMI payments");
  }

  let proofUrl = "";
  let proofKey = "";
  if (file) {
    const { uploadFile, storageConfigured } = await import("../../lib/storage");
    if (!storageConfigured()) throw new AppError("VALIDATION_ERROR", "File storage is not configured");
    const key = `invoices/${orgId}/${id}/proof-${Date.now()}-${file.originalName.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const uploaded = await uploadFile({ key, buffer: file.buffer, mimeType: file.mimeType, originalName: file.originalName });
    proofUrl = uploaded.url;
    proofKey = uploaded.key;
  }

  const payment = {
    method: input.method,
    amountMinor: input.amountMinor,
    paidOn: new Date(input.paidOn),
    reference: input.reference ?? "",
    notes: input.notes ?? "",
    accountName: input.accountName ?? "",
    chargesMinor: input.chargesMinor ?? 0,
    emi:
      input.method === "easebuzz_emi" && input.emi
        ? {
            bank: input.emi.bank ?? "",
            tenureMonths: input.emi.tenureMonths,
            monthlyAmountMinor: input.emi.monthlyAmountMinor ?? 0,
            interestPct: input.emi.interestPct ?? 0,
            processingFeeMinor: input.emi.processingFeeMinor ?? 0,
            transactionId: input.emi.transactionId ?? "",
          }
        : undefined,
    proofUrl,
    proofKey,
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
