import { Types, type PipelineStage } from "mongoose";
import {
  computeInvoiceLine,
  sumInvoiceTotals,
  roundingAdjustmentMinor,
  toBaseMinor,
  approvalBlocksSending,
  approvalBlocksEditing,
  type CreateInvoiceInput,
  type Invoice as InvoiceDTO,
  type InvoiceQuery,
  type InvoiceSummary,
  type MoneyByCurrency,
  type InvoiceStatus,
  type Paginated,
  type RecordPaymentInput,
  type UpdateInvoiceInput,
} from "@delta/shared";
import { AppError } from "../../lib/http";
import { assertOwned, scopeFilter, type Scope } from "../../lib/ownership";
import {
  notifyApprovers,
  notifyDecided,
} from "./approval-notify.service";
import { buildSort, pageMeta, searchOr, skipFor } from "../../lib/paginate";
import { resolveTagIds, toTagRefs } from "../../lib/tags";
import { nextNumber } from "../sequence/sequence.service";
import { invoiceNumberingFor, invoiceComputationDefaults } from "../organization/organization.service";
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
  const del = (doc as unknown as Record<string, unknown>).emailDelivery as
    | { state?: string; at?: Date; messageId?: string; error?: string }
    | undefined;
  return {
    id: doc._id.toString(),
    emailDelivery: del?.state
      ? {
          state: del.state as NonNullable<InvoiceDTO["emailDelivery"]>["state"],
          at: del.at ? new Date(del.at).toISOString() : "",
          messageId: del.messageId ?? "",
          error: del.error ?? "",
        }
      : undefined,
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
          meetingById: doc.enrolment.meetingById ? String(doc.enrolment.meetingById) : undefined,
          meetingBy: doc.enrolment.meetingBy ?? "",
          declaredPaidMinor: doc.enrolment.declaredPaidMinor ?? 0,
          declaredPaymentMethod: doc.enrolment.declaredPaymentMethod ?? undefined,
        }
      : undefined,
    approval: approvalDTO(doc),
    attachments: ((doc as unknown as { attachments?: unknown[] }).attachments ?? []).map((a) => {
      const r = a as Record<string, unknown>;
      return {
        name: r.name as string,
        url: r.url as string,
        key: r.key as string | undefined,
        size: r.size as number | undefined,
        mimeType: r.mimeType as string | undefined,
        uploadedAt: r.uploadedAt ? new Date(r.uploadedAt as Date).toISOString() : undefined,
      };
    }),
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
    roundOffMinor: (doc as unknown as { roundOffMinor?: number }).roundOffMinor ?? 0,
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
    baseTotalMinor: (doc as unknown as { baseTotalMinor?: number }).baseTotalMinor
      ?? (doc.totalMinor ?? 0),
    taxInclusive: (doc as unknown as { taxInclusive?: boolean }).taxInclusive ?? false,
    createdAt: doc.createdAt.toISOString(),
  };
}

/**
 * The approval as the client sees it.
 *
 * Defaulted for invoices raised before approval existed: they went out under
 * the old rules and must not now read as waiting for somebody.
 */
function approvalDTO(doc: unknown): InvoiceDTO["approval"] {
  const a = (doc as { approval?: Record<string, unknown> }).approval;
  return {
    state: (a?.state as InvoiceDTO["approval"]["state"]) ?? "not_required",
    byId: a?.byId ? String(a.byId) : undefined,
    byName: (a?.byName as string) ?? undefined,
    at: a?.at ? new Date(a.at as Date).toISOString() : undefined,
    returnedReason: (a?.returnedReason as string) ?? undefined,
    submittedAt: a?.submittedAt ? new Date(a.submittedAt as Date).toISOString() : undefined,
  };
}

/**
 * The HSN/SAC each of these catalogue items is sold under.
 *
 * One query for the whole invoice rather than one per line. Items that carry
 * no code of their own are simply absent, and the caller falls back.
 */
async function itemHsnSacFor(
  orgId: string,
  lines: { itemId?: string }[],
): Promise<Map<string, string>> {
  const ids = [...new Set(lines.map((l) => l.itemId).filter(Boolean) as string[])];
  if (ids.length === 0) return new Map();
  const { Item } = await import("../inventory/item.model");
  const items = await Item.find({ organizationId: orgId, _id: { $in: ids } })
    .select("hsnSac")
    .lean();
  return new Map(
    items
      .map((i) => [String(i._id), ((i as { hsnSac?: string }).hsnSac ?? "").trim()] as const)
      .filter(([, code]) => code.length > 0),
  );
}

function buildLines(
  raw: CreateInvoiceInput["lineItems"],
  taxInclusive = false,
  opts: { roundTotals?: boolean; defaultHsnSac?: string; itemHsnSac?: Map<string, string> } = {},
) {
  const { roundTotals = false, defaultHsnSac = "", itemHsnSac } = opts;
  const lineItems = raw.map((l) => {
    const b = computeInvoiceLine({ ...l, taxInclusive });
    return {
      description: l.description,
      quantity: l.quantity,
      unitPriceMinor: l.unitPriceMinor,
      discountPct: l.discountPct ?? 0,
      itemId: l.itemId,
      warehouseId: l.warehouseId,
      /*
       * Three places, most specific first.
       *
       * What was typed on the line wins; otherwise the catalogue item's own
       * code, because the code belongs to the thing being sold and two courses
       * on one invoice can differ; otherwise the organization's default, so a
       * single-service business types it once in Settings rather than on every
       * line of every invoice.
       */
      hsnSac:
        l.hsnSac?.trim() ||
        (l.itemId ? itemHsnSac?.get(String(l.itemId))?.trim() : "") ||
        defaultHsnSac,
      taxes: b.taxes,
      lineSubtotalMinor: b.lineSubtotalMinor,
      discountMinor: b.discountMinor,
      taxableMinor: b.taxableMinor,
      taxTotalMinor: b.taxTotalMinor,
      lineTotalMinor: b.lineTotalMinor,
    };
  });
  const summed = sumInvoiceTotals(raw.map((l) => ({ ...l, taxInclusive })));

  // The adjustment is folded into the total rather than shown beside it, so
  // that the figure the client is asked to pay is the one the invoice is worth.
  // Subtotal, tax and round-off still reconcile to it exactly.
  const roundOffMinor = roundTotals ? roundingAdjustmentMinor(summed.totalMinor) : 0;
  const totals = {
    ...summed,
    roundOffMinor,
    totalMinor: summed.totalMinor + roundOffMinor,
  };
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

/**
 * What is owed to somebody and what is waiting on them.
 *
 * Aggregated in the database rather than counted from a page of results: a
 * counsellor with two hundred enrolments is exactly the person who needs the
 * figure, and summing one page would quietly under-report for them.
 *
 * Grouped by currency because an organization may bill in more than one, and a
 * single total mixing dirhams with rupees is a wrong number rather than a
 * rounded one.
 */
export async function invoiceSummary(orgId: string, scope: Scope): Promise<InvoiceSummary> {
  const mine = { organizationId: new Types.ObjectId(orgId), ...scopeFilter(scope, "salespersonId") };
  const now = new Date();
  const owing = { status: { $in: ["sent", "viewed", "partial", "overdue"] }, balanceMinor: { $gt: 0 } };

  const byCurrency = (field: string): PipelineStage[] => [
    { $group: { _id: "$currency", minor: { $sum: field }, count: { $sum: 1 } } },
    { $sort: { minor: -1 } },
  ];
  const shape = (rows: { _id: string | null; minor: number; count: number }[]): MoneyByCurrency[] =>
    rows.map((r) => ({ currency: r._id ?? "AED", minor: r.minor, count: r.count }));

  const [outstanding, overdue, collected, awaitingApproval, returned] = await Promise.all([
    Invoice.aggregate([{ $match: { ...mine, ...owing } }, ...byCurrency("$balanceMinor")]),
    Invoice.aggregate([
      { $match: { ...mine, ...owing, dueDate: { $lt: now } } },
      ...byCurrency("$balanceMinor"),
    ]),
    // Money the counsellor says they took that nobody has recorded yet. The
    // difference, not the declared figure — a part-recorded payment still
    // leaves the remainder outstanding with them.
    Invoice.aggregate([
      {
        $match: {
          ...mine,
          "enrolment.declaredPaidMinor": { $gt: 0 },
          $expr: { $gt: ["$enrolment.declaredPaidMinor", { $ifNull: ["$amountPaidMinor", 0] }] },
        },
      },
      {
        $group: {
          _id: "$currency",
          minor: { $sum: { $subtract: ["$enrolment.declaredPaidMinor", { $ifNull: ["$amountPaidMinor", 0] }] } },
          count: { $sum: 1 },
        },
      },
      { $sort: { minor: -1 } } as PipelineStage,
    ]),
    Invoice.countDocuments({ ...mine, "approval.state": "pending" }),
    Invoice.countDocuments({ ...mine, "approval.state": "returned" }),
  ]);

  return {
    outstanding: shape(outstanding),
    overdue: shape(overdue),
    collectedNotRecorded: shape(collected),
    awaitingApproval,
    returned,
  };
}

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

  // An invoice raised before approval existed has no block at all, and reads
  // as needing nobody — so asking for "not_required" must include it.
  if (query.approval === "not_required") {
    and.push({ $or: [{ "approval.state": "not_required" }, { approval: { $exists: false } }] });
  } else if (query.approval) {
    and.push({ "approval.state": query.approval });
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

  /*
   * The name beside the id, resolved here rather than trusted from the form.
   *
   * A client could send any name it liked next to a real id, and the name is
   * what every screen shows — so the one that gets stored is the one the
   * database holds for that person, and only for somebody actually in this
   * organization.
   */
  let enrolment = input.enrolment;
  if (enrolment?.meetingById) {
    const met = await User.findOne({
      _id: enrolment.meetingById,
      "memberships.organizationId": orgId,
    }).select("name");
    if (!met) throw new AppError("VALIDATION_ERROR", "Invalid person selected for the meeting");
    enrolment = { ...enrolment, meetingBy: met.name };
  }

  /*
   * Who has to check this before it can go out.
   *
   * Two cases need it, for the same reason: somebody raising an invoice who can
   * only see their own records has nobody looking over the work, and an
   * enrolment is checked whoever typed it — the point there is that the figures
   * were verified, not who entered them.
   *
   * Everything else is `not_required`, so nothing an administrator or accountant
   * raises is held up, and turning this on does not put a backlog of existing
   * drafts in front of anybody.
   */
  const needsApproval = !scope.all || Boolean(enrolment);
  const approval = needsApproval
    ? { state: "pending" as const, submittedAt: new Date() }
    : { state: "not_required" as const };

  /*
   * The rate that connects this invoice to the organization's own currency.
   *
   * Taken from the form when it is given — a rate somebody agreed in a contract
   * beats whatever a public feed says today — and looked up only when it is
   * not. A lookup that fails refuses the invoice instead of storing 1.0, which
   * would read afterwards as a rate somebody had checked.
   */
  const baseCurrency = org?.baseCurrency ?? "AED";
  const invoiceCurrency = input.currency ?? customer.currency ?? "AED";
  let exchangeRate = input.exchangeRate;
  if (exchangeRate === undefined) {
    const looked = await getExchangeRate(baseCurrency, invoiceCurrency);
    if (looked === null) {
      throw new AppError(
        "VALIDATION_ERROR",
        `Could not find today's rate for ${invoiceCurrency} against ${baseCurrency}. Enter it on the invoice.`,
      );
    }
    exchangeRate = looked;
  }

  const computation = await invoiceComputationDefaults(orgId);
  const { lineItems, totals } = buildLines(input.lineItems, input.taxInclusive ?? false, {
    roundTotals: computation.roundTotals,
    defaultHsnSac: computation.hsnSac,
    itemHsnSac: await itemHsnSacFor(orgId, input.lineItems),
  });
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
    approval,
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
    roundOffMinor: totals.roundOffMinor,
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
    exchangeRate,
    // The total in the organization's own currency, stored rather than derived,
    // so a report across mixed currencies is one sum instead of a join against
    // whatever the rate was that day.
    baseTotalMinor: toBaseMinor(totals.totalMinor, exchangeRate),
    taxInclusive: input.taxInclusive ?? false,
  });
  await doc.populate("tagIds", "name color");
  // Straight into the approval queue. Not awaited: the invoice exists either
  // way, and a mail outage must not fail the creation.
  if (needsApproval) void notifyApprovers(doc as unknown as InvoiceDoc);
  return toDTO(doc);
}

/**
 * Whether an invoice is still the person who raised it's to change.
 *
 * Approval is worth nothing if the figures can move afterwards. Once somebody
 * has approved an invoice, what they approved is what it says — so a
 * salesperson may no longer touch it, and a correction goes through accounts,
 * who can see the whole picture the approval was given against.
 *
 * The same holds while it is *waiting*: editing then changes what an approver
 * is part-way through reading.
 *
 * Sent back is the one state that stays open, because correcting it is exactly
 * what should happen next. And somebody who can see the whole organization is
 * never held to this — making the correction is their job.
 */
function assertEditable(doc: unknown, scope: Scope): void {
  if (scope.all) return;
  const state = approvalOf(doc).state;
  if (!approvalBlocksEditing(state as never)) return;
  if (state === "pending") {
    throw new AppError("CONFLICT", "This is with an approver and cannot be changed until it comes back");
  }
  if (state === "approved") {
    throw new AppError(
      "CONFLICT",
      "This has been approved, so it can no longer be changed. Ask accounts to make the correction.",
    );
  }
}

export async function updateInvoice(
  orgId: string,
  id: string,
  input: UpdateInvoiceInput,
  scope: Scope,
): Promise<InvoiceDTO> {
  const doc = await findDoc(orgId, id);
  assertOwned(scope, doc.salespersonId, "Invoice");
  assertEditable(doc, scope);

  /*
   * An invoice that has gone out can still be corrected.
   *
   * It could not be, and the reasoning was that a sent invoice is a document
   * the client is holding. But a wrong invoice in a client's hands is the case
   * that most needs fixing, and the only way to fix it was to void the invoice
   * and raise another — losing the number, the history and any payment already
   * recorded against it. People did it anyway, badly.
   *
   * A voided invoice stays shut. That is a cancelled record rather than a
   * wrong one, and it has its own way back now.
   */
  const before = effectiveStatus(doc);
  if (before === "void") {
    throw new AppError(
      "CONFLICT",
      "This invoice was voided. Restore it first, then make the correction.",
    );
  }

  const paid = (doc.amountPaidMinor as number) ?? 0;
  // What was sold before the edit, kept for the stock reconciliation below:
  // doc.lineItems is about to be replaced in place.
  const linesBefore = JSON.parse(
    JSON.stringify((doc.lineItems as unknown as unknown[]) ?? []),
  ) as { itemId?: string; warehouseId?: string; quantity: number; description: string }[];

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
    const computation = await invoiceComputationDefaults(orgId);
    const { lineItems, totals } = buildLines(input.lineItems, effectiveTaxInclusive, {
      roundTotals: computation.roundTotals,
      defaultHsnSac: computation.hsnSac,
      itemHsnSac: await itemHsnSacFor(orgId, input.lineItems),
    });
    // Editing below what has already been received would make the balance
    // negative, which an invoice cannot express — the customer would be owed
    // money back, and that is a credit note rather than a smaller invoice.
    if (totals.totalMinor < paid) {
      throw new AppError(
        "CONFLICT",
        `${formatMoney(paid, doc.currency ?? "AED")} has already been received against this invoice, so it cannot be reduced to ${formatMoney(totals.totalMinor, doc.currency ?? "AED")}. Raise a credit note for the difference, or remove the payment first.`,
      );
    }

    doc.set({
      lineItems,
      subtotalMinor: totals.subtotalMinor,
      discountTotalMinor: totals.discountTotalMinor,
      taxBreakdown: totals.taxBreakdown,
      taxTotalMinor: totals.taxTotalMinor,
      roundOffMinor: totals.roundOffMinor,
      totalMinor: totals.totalMinor,
      balanceMinor: totals.totalMinor - paid,
    });

    // The status describes what is outstanding, so changing the total changes
    // it: an invoice edited down to what was paid is settled, one edited up is
    // owed again. Drafts keep their status — nothing has been sent, so there
    // is nothing for a balance to mean yet.
    if (before !== "draft") {
      doc.status = doc.balanceMinor <= 0 ? "paid" : paid > 0 ? "partial" : "sent";
    }
  }
  if (input.tagIds !== undefined) {
    doc.set("tagIds", await resolveTagIds(orgId, input.tagIds));
  }
  await doc.save();

  // Stock follows what was sold. Only for an invoice that had already gone
  // out: a draft has taken nothing off the shelf yet.
  if (input.lineItems && before !== "draft") {
    void _reconcileInventory(orgId, doc, linesBefore);
  }

  await doc.populate("tagIds", "name color");
  return toDTO(doc);
}

async function _reconcileInventory(
  orgId: string,
  doc: InvoiceDoc,
  linesBefore: { itemId?: string; warehouseId?: string; quantity: number; description: string }[],
) {
  try {
    const lines = (doc.lineItems as unknown as { itemId?: string; warehouseId?: string; quantity: number; description: string }[]) ?? [];
    // Nothing tracked on either side of the edit: no stock was ever involved.
    if (!lines.some((l) => l.itemId) && !linesBefore.some((l) => l.itemId)) return;
    const { reconcileStockForInvoice } = await import("../inventory/inventory.service");
    await reconcileStockForInvoice(orgId, String(doc._id), doc.invoiceNumber, lines, "system");
  } catch (err) {
    const { logger } = await import("../../lib/logger");
    logger.error({ err }, "Inventory reconciliation failed after an invoice edit");
  }
}

/**
 * Bring a voided invoice back.
 *
 * Voiding is how an invoice raised in error is taken out of the books, and
 * until now it was the end of that invoice: the number, the enrolment attached
 * to it and anything recorded against it were spent. Somebody who voided the
 * wrong one, or voided the right one and then needed it after all, had to
 * raise a new invoice and explain the gap.
 *
 * Where nothing was paid it comes back as a draft, which is the state it can
 * be corrected in and sent from — the same path a new invoice takes.
 *
 * Where money was received it cannot: a draft that has taken payment is not a
 * draft. Those come back to what their payments make them, and can be
 * corrected in place like any other sent invoice.
 */
/**
 * Put an approved enrolment in the queue for the LMS.
 *
 * Deliberately narrow. Only an enrolment the sales CRM raised reaches the LMS:
 * an invoice accounts typed here themselves is a billing document, not a sale
 * of a course to a student, and giving somebody access to a course because a
 * bookkeeper raised an invoice would be a surprise of the worst kind. So the
 * test is where it came from, not what it looks like.
 *
 * The course arrives as a slug from the mapped item, because the enrolment's
 * own `course` is free text and this database holds nine spellings of three
 * courses. Unmapped, nothing is sent and the row says why, so the invoice can
 * be found and the item mapped — rather than guessing at a name and enrolling
 * somebody on the wrong course.
 *
 * Never throws. Approving is the approver's act; it does not fail because
 * another system is unreachable, unmapped or switched off.
 */
export async function queueLmsProvision(orgId: string, doc: InvoiceDoc): Promise<void> {
  try {
    const { lmsConfigured } = await import("../../lib/lms-client");
    if (!lmsConfigured()) return;

    const d = doc as unknown as Record<string, unknown>;
    const external = d.external as { source?: string } | undefined;
    if (external?.source !== "crm") return;
    if (!(d.enrolment as { course?: string } | undefined)?.course) return;

    const { LmsProvision } = await import("../integrations/lms-provision.model");
    if (await LmsProvision.exists({ invoiceId: doc._id })) return;

    const [customer, { Item }] = await Promise.all([
      Customer.findById(doc.customerId).lean(),
      import("../inventory/item.model"),
    ]);

    // The first line that names an item we have mapped. An enrolment is one
    // course on one invoice, so there is no question of choosing between two.
    const lines = (doc.lineItems as unknown as { itemId?: string }[]) ?? [];
    let courseSlug = "";
    for (const line of lines) {
      if (!line.itemId) continue;
      const item = await Item.findById(line.itemId).select("lmsCourseSlug").lean<{ lmsCourseSlug?: string } | null>();
      const slug = item?.lmsCourseSlug?.trim();
      if (slug) { courseSlug = slug; break; }
    }

    const base = {
      organizationId: doc.organizationId,
      invoiceId: doc._id,
      invoiceNumber: doc.invoiceNumber,
    };

    if (!courseSlug) {
      // Recorded rather than dropped: an enrolment nobody provisioned is worth
      // finding, and "no course mapped" is the answer somebody needs.
      await LmsProvision.create({
        ...base,
        payload: {},
        status: "unmapped",
        lastError: "No LMS course is mapped to the item on this invoice",
      });
      const { logger } = await import("../../lib/logger");
      logger.warn({ invoice: doc.invoiceNumber }, "Approved enrolment has no LMS course mapped");
      return;
    }

    const email = (customer as { email?: string } | null)?.email?.trim();
    if (!email) {
      await LmsProvision.create({
        ...base,
        payload: {},
        status: "unmapped",
        lastError: `${doc.customerName} has no email address, so there is no LMS account to create`,
      });
      return;
    }

    await LmsProvision.create({
      ...base,
      payload: {
        email,
        name: doc.customerName,
        ...((customer as { phone?: string } | null)?.phone ? { phone: (customer as { phone?: string }).phone } : {}),
        courseSlug,
        invoiceId: String(doc._id),
        invoiceNumber: doc.invoiceNumber,
        // Whole units: the LMS records orders the way its own gateways do.
        amount: Math.round((doc.totalMinor ?? 0) / 100),
      },
      status: "pending",
    });
  } catch (err) {
    const { logger } = await import("../../lib/logger");
    logger.error({ err, invoiceId: String(doc._id) }, "Could not queue the LMS provisioning");
  }
}

export async function restoreInvoice(orgId: string, id: string): Promise<InvoiceDTO> {
  const doc = await findDoc(orgId, id);
  if ((doc.status as string) !== "void") {
    throw new AppError("CONFLICT", "Only a voided invoice can be restored");
  }

  const paid = (doc.amountPaidMinor as number) ?? 0;
  const total = (doc.totalMinor as number) ?? 0;
  doc.status = paid <= 0 ? "draft" : paid >= total ? "paid" : "partial";
  doc.balanceMinor = total - paid;
  // It is not a sent document again until somebody sends it.
  if (doc.status === "draft") doc.set("sentAt", undefined);
  await doc.save();

  // Voiding put the stock back. An invoice returning to a sent state is
  // selling it again; one returning to draft has sold nothing yet.
  if (doc.status !== "draft") {
    void _reconcileInventory(orgId, doc as unknown as InvoiceDoc, []);
  }

  await doc.populate("tagIds", "name color");
  return toDTO(doc);
}

/** Ten is plenty for an ID, a form and a payment slip, and stops a runaway loop. */
const MAX_ATTACHMENTS = 10;

export async function addAttachment(
  orgId: string,
  id: string,
  file: { buffer: Buffer; originalName: string; mimeType: string },
  scope: Scope,
): Promise<InvoiceDTO> {
  const doc = await findDoc(orgId, id);
  assertOwned(scope, doc.salespersonId, "Invoice");
  assertEditable(doc, scope);

  const existing = (doc as unknown as { attachments?: unknown[] }).attachments ?? [];
  if (existing.length >= MAX_ATTACHMENTS) {
    throw new AppError("CONFLICT", `An invoice can hold at most ${MAX_ATTACHMENTS} documents`);
  }

  const { uploadFile, storageConfigured } = await import("../../lib/storage");
  if (!storageConfigured()) throw new AppError("VALIDATION_ERROR", "File storage is not configured");

  // The uploader's filename never becomes the key. It is theirs to choose, and
  // a key built from it could otherwise reach outside this invoice's prefix.
  const safe = file.originalName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  const uploaded = await uploadFile({
    key: `invoices/${orgId}/${id}/${Date.now()}-${safe}`,
    buffer: file.buffer,
    mimeType: file.mimeType,
    originalName: file.originalName,
  });

  (existing as Record<string, unknown>[]).push({
    name: file.originalName.slice(0, 200),
    url: uploaded.url,
    key: uploaded.key,
    size: uploaded.size,
    mimeType: uploaded.mimeType,
    uploadedAt: new Date(),
  });
  doc.set("attachments", existing);
  await doc.save();
  return toDTO(doc as unknown as InvoiceDoc);
}

export async function removeAttachment(
  orgId: string,
  id: string,
  key: string,
  scope: Scope,
): Promise<InvoiceDTO> {
  const doc = await findDoc(orgId, id);
  assertOwned(scope, doc.salespersonId, "Invoice");
  assertEditable(doc, scope);

  const list = ((doc as unknown as { attachments?: { key?: string }[] }).attachments ?? []);
  const idx = list.findIndex((a) => a.key === key);
  if (idx === -1) throw new AppError("NOT_FOUND", "Document not found");

  const [removed] = list.splice(idx, 1);
  doc.set("attachments", list);
  await doc.save();

  // The row going is what the caller asked for; the object not going is a
  // tidiness problem, not a reason to fail and leave the row behind.
  if (removed?.key) {
    try {
      const { deleteFile } = await import("../../lib/storage");
      await deleteFile(removed.key);
    } catch (err) {
      const { logger } = await import("../../lib/logger");
      logger.error({ err, key: removed.key }, "Removed an invoice document but could not delete the object");
    }
  }
  return toDTO(doc as unknown as InvoiceDoc);
}

/**
 * Remove an invoice that should not be on the books at all.
 *
 * A draft never left the building, so it can go. A voided one is the other
 * case: it has been cancelled already, and somebody clearing up a mistaken
 * invoice should not have to leave the cancelled shell behind for ever. It
 * costs a gap in the numbering, which is the deliberate price of the choice —
 * voiding, which keeps the number, remains the ordinary way to cancel.
 *
 * Anything else is a record of something that happened, and the client has a
 * copy.
 *
 * A voided invoice still goes only when nothing depends on it. A payment, a
 * credit note, a commission or a quotation that was converted into it all
 * point at this document, and deleting it underneath them leaves rows
 * referring to an invoice that no longer exists — worse than the shell it was
 * tidying away.
 */
export async function deleteInvoice(orgId: string, id: string): Promise<void> {
  const doc = await findDoc(orgId, id);
  const status = effectiveStatus(doc);

  if (status !== "draft" && status !== "void") {
    throw new AppError("CONFLICT", "Only draft or voided invoices can be deleted");
  }

  if (status === "void") {
    const payments = (doc.payments as unknown as unknown[]) ?? [];
    if (payments.length > 0) {
      throw new AppError(
        "CONFLICT",
        "This invoice has payments recorded against it. Remove them first, or leave it voided.",
      );
    }

    const objectId = new Types.ObjectId(id);
    const [{ CreditNote }, { CommissionRecord }, { Quotation }] = await Promise.all([
      import("../credit-note/credit-note.model"),
      import("../commission/commission-record.model"),
      import("../quotation/quotation.model"),
    ]);

    const [credited, commissioned, quoted] = await Promise.all([
      CreditNote.exists({ organizationId: orgId, invoiceId: objectId }),
      CommissionRecord.exists({ organizationId: orgId, invoiceId: objectId }),
      Quotation.exists({
        organizationId: orgId,
        $or: [{ "convertedTo.invoiceId": objectId }, { "convertedTo.invoiceIds": objectId }],
      }),
    ]);

    if (credited) throw new AppError("CONFLICT", "A credit note refers to this invoice, so it cannot be deleted");
    if (commissioned) throw new AppError("CONFLICT", "A commission was calculated from this invoice, so it cannot be deleted");
    if (quoted) throw new AppError("CONFLICT", "A quotation was converted into this invoice, so it cannot be deleted");
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
 * Approve an invoice, which is what lets it be sent and paid.
 *
 * Recorded against a name and a time. Whoever raised it cannot do this — the
 * route is behind `invoice:write`, which somebody limited to their own records
 * does not have.
 */
export async function approveInvoice(
  orgId: string,
  id: string,
  actor: { userId: string; name: string },
): Promise<InvoiceDTO> {
  const doc = await findDoc(orgId, id);
  const a = approvalOf(doc);
  if (a.state === "not_required") throw new AppError("CONFLICT", "This invoice does not need approval");
  if (a.state === "approved") throw new AppError("CONFLICT", "This invoice is already approved");

  doc.set("approval", {
    state: "approved",
    byId: new Types.ObjectId(actor.userId),
    byName: actor.name,
    at: new Date(),
    // Cleared, because it has been acted on. Leaving it would read as a
    // standing objection to something that has since been approved.
    returnedReason: undefined,
    submittedAt: a.submittedAt,
  });
  await doc.save();

  void notifyDecided(doc, actor.name, "approved");
  void queueLmsProvision(orgId, doc);
  return toDTO(doc as unknown as InvoiceDoc);
}

/** Send an invoice back to whoever raised it, with a reason they can act on. */
export async function returnInvoice(
  orgId: string,
  id: string,
  reason: string,
  actor: { userId: string; name: string },
): Promise<InvoiceDTO> {
  const doc = await findDoc(orgId, id);
  const a = approvalOf(doc);
  if (a.state === "not_required") throw new AppError("CONFLICT", "This invoice does not need approval");
  if (effectiveStatus(doc) !== "draft") {
    throw new AppError("CONFLICT", "Only an unsent invoice can be sent back");
  }

  doc.set("approval", {
    state: "returned",
    byId: new Types.ObjectId(actor.userId),
    byName: actor.name,
    at: new Date(),
    returnedReason: reason,
    submittedAt: a.submittedAt,
  });
  await doc.save();

  /*
   * Only for invoices raised here.
   *
   * An enrolment that came from another system belongs to somebody who works in
   * that system, and this notice would reach them — if it reached them at all —
   * as a message about an invoice number, linking to a screen they have no
   * login for. Worse, it goes to whoever the invoice is *assigned* to here,
   * which for a rep with no account in finance is an administrator standing in
   * for them: the one person it is not about.
   *
   * The source system is told through the status its own screens already poll,
   * and it writes to the rep in its own words, about its own record. Two emails
   * about one send-back, one of them useless, is worse than one that works.
   */
  const fromElsewhere = Boolean((doc as unknown as { external?: { source?: string } }).external?.source);
  if (!fromElsewhere) void notifyDecided(doc, actor.name, "returned", reason);

  return toDTO(doc as unknown as InvoiceDoc);
}

/**
 * Put a corrected invoice back in front of an approver.
 *
 * Whoever raised it does this themselves, so it is the one transition they may
 * make on their own record.
 */
export async function resubmitInvoice(
  orgId: string,
  id: string,
  scope: Scope,
): Promise<InvoiceDTO> {
  const doc = await findDoc(orgId, id);
  assertOwned(scope, doc.salespersonId, "Invoice");
  if (approvalOf(doc).state !== "returned") {
    throw new AppError("CONFLICT", "Only an invoice that was sent back can be submitted again");
  }

  doc.set("approval.state", "pending");
  doc.set("approval.submittedAt", new Date());
  await doc.save();

  void notifyApprovers(doc as unknown as InvoiceDoc);
  return toDTO(doc as unknown as InvoiceDoc);
}

/** The approval block, defaulted for invoices raised before there was one. */
function approvalOf(doc: unknown): {
  state: string;
  returnedReason?: string;
  submittedAt?: Date;
} {
  const a = (doc as { approval?: Record<string, unknown> }).approval;
  return {
    state: (a?.state as string) ?? "not_required",
    returnedReason: a?.returnedReason as string | undefined,
    submittedAt: a?.submittedAt as Date | undefined,
  };
}

/**
 * Refuse to put an invoice in front of a client before it has been checked.
 *
 * Silent for an invoice that needs no approval, which is every invoice raised
 * by somebody trusted with the whole ledger — so turning this on for
 * salespeople does not land a backlog of existing drafts in front of anybody.
 */
function assertApproved(doc: unknown): void {
  const a = approvalOf(doc);
  if (!approvalBlocksSending(a.state as never)) return;
  throw new AppError(
    "CONFLICT",
    a.state === "returned"
      ? `This invoice was sent back and needs correcting first${a.returnedReason ? `: ${a.returnedReason}` : ""}.`
      : "This invoice is waiting for approval.",
  );
}

export async function sendInvoice(orgId: string, id: string, scope: Scope): Promise<InvoiceDTO> {
  const doc = await findDoc(orgId, id);
  assertOwned(scope, doc.salespersonId, "Invoice");
  const eff = effectiveStatus(doc);
  if (eff !== "draft") throw new AppError("CONFLICT", `Cannot send a ${eff} invoice`);
  assertApproved(doc);

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

/** Record what became of an attempt, so the invoice stops claiming it was sent. */
async function _recordDelivery(
  invoiceId: unknown,
  state: "sent" | "failed" | "no_address" | "not_configured",
  extra: { messageId?: string; error?: string } = {},
): Promise<void> {
  await Invoice.findByIdAndUpdate(invoiceId, {
    $set: {
      emailDelivery: {
        state,
        at: new Date(),
        messageId: extra.messageId ?? "",
        error: extra.error ?? "",
      },
      ...(extra.messageId ? { lastEmailId: extra.messageId } : {}),
    },
  }).catch(() => {});
}

async function _dispatchInvoiceEmail(orgId: string, doc: InvoiceDoc, message?: string) {
  try {
    const [customer, org] = await Promise.all([
      Customer.findById(doc.customerId),
      Organization.findById(orgId),
    ]);
    // A customer with no address is the commonest reason an invoice was never
    // emailed, and it used to leave no trace at all.
    if (!customer?.email) {
      await _recordDelivery(doc._id, "no_address", {
        error: `${doc.customerName} has no email address on file`,
      });
      return;
    }
    const orgName = org?.name ?? "Delta Finance";
    const footerText = (org?.branding as { footerText?: string })?.footerText ?? "";
    // The organization's own logo where it has set one; the email template
    // falls back to Delta's otherwise.
    const logoUrl = (org?.branding as { logoUrl?: string })?.logoUrl ?? "";
    const totalFormatted = formatMoney(doc.totalMinor ?? 0, doc.currency ?? "AED");

    /*
     * The invoice itself, drawn here and attached.
     *
     * The message has always described the invoice and left the reader to log
     * in somewhere for the document. The same drawing the download uses, from
     * shared, so what is emailed and what is downloaded cannot differ.
     *
     * Failing to draw it must not stop the message: an invoice email without
     * its attachment is worth far more than no email at all, so this falls
     * back to what was sent before rather than throwing.
     */
    let attachments: { filename: string; content: Buffer; contentType?: string }[] | undefined;
    try {
      const { invoicePdfBuffer, invoicePdfName } = await import("@delta/shared");
      const bankAccountId = (org as unknown as { invoiceDefaults?: { bankAccountId?: unknown } })
        ?.invoiceDefaults?.bankAccountId;
      const bankAccount = bankAccountId
        ? await (await import("../banking/bank-account.model")).BankAccount.findById(bankAccountId).lean()
        : null;
      attachments = [
        {
          filename: invoicePdfName(doc.invoiceNumber),
          content: invoicePdfBuffer({
            invoice: toDTO(doc),
            org: org as never,
            customer: customer as never,
            bankAccount: bankAccount as never,
          }),
          contentType: "application/pdf",
        },
      ];
    } catch (err) {
      const { logger } = await import("../../lib/logger");
      logger.warn({ err, invoiceId: String(doc._id) }, "Could not draw the invoice PDF — sending without it");
    }

    // The invoice written out for the message body. The attachment is the
    // document; this is so it can be read on a phone without opening one.
    const dto = toDTO(doc);
    const m = (minor: number) => formatMoney(minor, doc.currency ?? "AED");
    const detail = {
      lineItems: dto.lineItems.map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unitPrice: m(l.unitPriceMinor),
        amount: m(l.lineTotalMinor),
      })),
      subtotal: m(dto.subtotalMinor),
      taxes: dto.taxBreakdown.map((t) => ({ label: t.code, amount: m(t.amountMinor) })),
      total: m(dto.totalMinor),
      ...(dto.amountPaidMinor > 0 ? { amountPaid: m(dto.amountPaidMinor) } : {}),
      balanceDue: m(dto.balanceMinor),
      issueDate: dto.issueDate,
      ...(dto.reference ? { reference: dto.reference } : {}),
    };

    const { id: emailId, error } = await sendInvoiceEmail({
      to: customer.email,
      orgName,
      invoiceNumber: doc.invoiceNumber,
      customerName: doc.customerName,
      totalFormatted,
      dueDate: dateOnly(doc.dueDate),
      footerText,
      logoUrl,
      message,
      detail,
      attachments,
    });

    if (error) {
      await _recordDelivery(doc._id, error === "not_configured" ? "not_configured" : "failed", { error });
      // No reminders behind a message that never arrived: chasing payment for
      // an invoice the customer has not seen is worse than not chasing.
      return;
    }
    await _recordDelivery(doc._id, "sent", { messageId: emailId });

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
    // non-fatal — email failure must not block the send action, but it is
    // written down rather than only logged, because a log nobody reads is how
    // this went unnoticed for months.
    const { logger } = await import("../../lib/logger");
    logger.error({ err }, "Invoice email dispatch failed");
    await _recordDelivery(doc._id, "failed", {
      error: err instanceof Error ? err.message : "dispatch failed",
    });
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

/**
 * Remove a payment that should not have been recorded.
 *
 * For a payment entered by mistake — the wrong invoice, a duplicate, an amount
 * typed twice. Editing covers a wrong figure; this covers one that should not
 * be there at all, and without it the only remedy was to edit the amount down
 * to nothing and leave a payment of zero on the record.
 *
 * The invoice's paid total, balance and status are recomputed from what is
 * left, exactly as editing one does — a payment removed without that would
 * leave an invoice claiming money it no longer holds.
 *
 * Refused on a voided invoice, on the same grounds editing is: a void invoice
 * is a record of something that was cancelled, not a document to keep working
 * on.
 */
export async function deletePayment(
  orgId: string,
  id: string,
  paymentId: string,
): Promise<InvoiceDTO> {
  const doc = await findDoc(orgId, id);
  if (effectiveStatus(doc) === "void") {
    throw new AppError("CONFLICT", "Cannot delete a payment on a voided invoice");
  }

  const list = doc.payments as unknown as {
    id: (pid: string) => ({ deleteOne: () => void }) | null;
  };
  const pm = list.id(paymentId);
  if (!pm) throw new AppError("NOT_FOUND", "Payment not found");
  pm.deleteOne();

  const remaining = (doc.payments as unknown as { amountMinor?: number }[])
    .reduce((sum, p) => sum + (p.amountMinor ?? 0), 0);

  doc.amountPaidMinor = remaining;
  doc.balanceMinor = (doc.totalMinor ?? 0) - remaining;
  // Back to "sent" when nothing is left against it: an invoice with no payment
  // is not partially paid, it is simply outstanding. effectiveStatus still
  // decides whether that reads as overdue.
  doc.status = doc.balanceMinor <= 0 ? "paid" : remaining > 0 ? "partial" : "sent";

  await doc.save();
  await doc.populate("tagIds", "name color");
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
  assertApproved(doc);

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
