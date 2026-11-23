import { Types } from "mongoose";
import {
  formatMoney, type CourseChange, type DecideCourseChangeInput, type InboundCourseChange,
} from "@delta/shared";
import type { AuthContext } from "../../middleware/auth";
import { env } from "../../config/env";
import { AppError } from "../../lib/http";
import { logger } from "../../lib/logger";
import { sendNotice } from "../../lib/email";
import { withAccountants } from "../../lib/approval-recipients";
import { Invoice } from "../invoice/invoice.model";
import { Item, itemLmsCourses } from "../inventory/item.model";
import { LmsProvision } from "../integrations/lms-provision.model";
import { Role } from "../role/role.model";
import { User } from "../user/user.model";
import { CourseChangeModel } from "./course-change.model";

/*
 * Course changes from the sales CRMs (the user, 2026-11-23): a finance-approved
 * enrolment moved to another course at another fee, asked for by the
 * salesperson with a reason. It waits on the Approvals page like a balance
 * payment; approved, the invoice line becomes the new course at the new fee
 * (totals, balance, status and CS Portal's figures follow, as an edit on the
 * invoice screen does — the approval stays), the enrolment says the new course
 * and the LMS opens what it adds — the course-only path of
 * scripts/enrolment-change.ts. Rejected, with why. The CRM reads where each one
 * stands with the enrolment's status (courseChangesFor below).
 */

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : "");
/** Course names as people type them: case and spaces aside. */
const sameCourse = (a: unknown, b: unknown) => String(a ?? "").toLowerCase().replace(/\s+/g, "") === String(b ?? "").toLowerCase().replace(/\s+/g, "");

const INVOICE_FIELDS = "organizationId invoiceNumber customerName currency totalMinor amountPaidMinor balanceMinor status approval enrolment.course lineItems";

/** Why the enrolment cannot move to this course at this fee as it stands, or null. `waiting`: another one still pending. */
function refusalFor(invoice: any, course: string, priceMinor: number, waiting?: any): string | null {
  if (!invoice) return "The enrolment is not in finance";
  const n = invoice.invoiceNumber;
  const cur = invoice.currency ?? "AED";
  if (invoice.status === "void") return `Invoice ${n} is void`;
  if (invoice.approval?.state !== "approved") return `Invoice ${n} is not approved yet — correct it in the CRM`;
  if (waiting) return `A course change for invoice ${n} (to ${waiting.course?.name ?? "another course"}) is already waiting for finance`;
  // updateInvoice would refuse it too: an invoice cannot be edited below what was received.
  const paid = Number(invoice.amountPaidMinor) || 0;
  if (priceMinor < paid) return `${formatMoney(paid, cur)} is already paid — the new fee can't be less`;
  if (sameCourse(invoice.enrolment?.course, course) && priceMinor === (Number(invoice.totalMinor) || 0)) {
    return `Nothing changes — invoice ${n} is already ${invoice.enrolment?.course} at ${formatMoney(priceMinor, cur)}`;
  }
  return null;
}

export function courseChangeDTO(r: any, invoice?: any): CourseChange {
  const c = r.course ?? {};
  const paid = Number(invoice?.amountPaidMinor) || 0;
  return {
    id: String(r._id),
    status: r.status,
    source: r.source,
    invoiceId: String(r.invoiceId),
    invoiceNumber: r.invoiceNumber ?? "",
    customerName: r.customerName ?? "",
    fromCourse: r.fromCourse ?? "",
    fromPriceMinor: r.fromPriceMinor ?? 0,
    course: {
      name: c.name ?? "",
      ...(c.itemId ? { itemId: c.itemId } : {}),
      ...(c.hsnSac ? { hsnSac: c.hsnSac } : {}),
      ...(c.lmsCourseSlug ? { lmsCourseSlug: c.lmsCourseSlug } : {}),
      ...(c.lmsCourseSlugs?.length ? { lmsCourseSlugs: [...c.lmsCourseSlugs] } : {}),
    },
    priceMinor: r.priceMinor,
    currency: r.currency,
    reason: r.reason ?? "",
    requestedBy: { name: r.requestedBy?.name ?? "", email: r.requestedBy?.email ?? "" },
    receivedAt: iso(r.createdAt),
    ...(invoice
      ? {
          invoice: {
            totalMinor: invoice.totalMinor ?? 0, paidMinor: paid, balanceMinor: invoice.balanceMinor ?? 0, status: invoice.status ?? "",
            balanceAfterMinor: Math.max(0, (r.priceMinor ?? 0) - paid),
          },
        }
      : {}),
    // Not while it waits: a decision being made right now is not one yet.
    ...(r.decision?.decidedAt && r.status !== "pending"
      ? {
          decision: {
            decidedByName: r.decision.decidedByName ?? "",
            decidedAt: iso(r.decision.decidedAt),
            ...(r.decision.reason ? { reason: r.decision.reason } : {}),
            ...(r.decision.note ? { note: r.decision.note } : {}),
          },
        }
      : {}),
  };
}

/** Everyone here who approves enrolments, and the accountants: told one is waiting. Never throws. */
async function tellApprovers(orgId: string, c: CourseChange): Promise<void> {
  try {
    const org = new Types.ObjectId(orgId);
    const roles = await Role.find({ organizationId: org, $or: [{ permissions: "invoice:write" }, { permissions: "*" }] }).select("_id");
    const people = roles.length
      ? await User.find({ status: "active", memberships: { $elemMatch: { organizationId: org, roleId: { $in: roles.map((r) => r._id) }, status: { $nin: ["suspended", "invited"] } } } }).select("email")
      : [];
    const to = await withAccountants(org, people.map((u) => u.email as string).filter(Boolean));
    if (!to.length) return;
    await sendNotice({
      log: { organizationId: orgId, kind: "course_change_notice", ref: { type: "invoice", id: c.invoiceId, label: c.invoiceNumber } },
      to,
      subject: `Course change to approve: ${c.customerName} — ${c.course.name}`,
      title: "A course change from a sales CRM is waiting for approval",
      lines: [
        `${c.requestedBy.name || "The salesperson"} asks to move ${c.customerName} (invoice ${c.invoiceNumber}) from ${c.fromCourse || "their course"} at ${formatMoney(c.fromPriceMinor, c.currency)} to ${c.course.name} at ${formatMoney(c.priceMinor, c.currency)}.`,
        `Why: ${c.reason}`,
        "Approving it changes the invoice line to the new course at the new fee (the balance follows), the enrolment's course, and opens any new LMS course.",
      ],
      actionLabel: "Review it",
      actionUrl: `${env.WEB_ORIGIN}/approvals`,
    });
  } catch (err) {
    logger.error({ err }, "Could not tell anyone a course change is waiting");
  }
}

/** A CRM's course change, received — or the one it already sent under that id. */
export async function intakeCourseChange(orgId: string, input: InboundCourseChange): Promise<CourseChange> {
  await CourseChangeModel.init();
  const org = new Types.ObjectId(orgId);
  const made = await CourseChangeModel.findOne({ organizationId: org, source: input.source, externalId: input.externalId }).lean();
  if (made) return courseChangeDTO(made);
  const invoice: any = await Invoice.findOne({ organizationId: org, "external.source": input.source, "external.externalId": input.enrolmentExternalId })
    .select(INVOICE_FIELDS).lean();
  const waiting = invoice ? await CourseChangeModel.findOne({ invoiceId: invoice._id, status: "pending" }).select("course.name").lean() : null;
  const refusal = refusalFor(invoice, input.course.name, input.priceMinor, waiting);
  if (refusal) throw new AppError(invoice ? "CONFLICT" : "NOT_FOUND", refusal);
  const course = input.course;
  let row;
  try {
    row = await CourseChangeModel.create({
      organizationId: org,
      source: input.source,
      externalId: input.externalId,
      invoiceId: invoice._id,
      invoiceNumber: invoice.invoiceNumber ?? "",
      customerName: invoice.customerName ?? "",
      fromCourse: invoice.enrolment?.course ?? "",
      fromPriceMinor: invoice.totalMinor ?? 0,
      course: {
        name: course.name.trim(),
        ...(course.itemId?.trim() ? { itemId: course.itemId.trim() } : {}),
        ...(course.hsnSac?.trim() ? { hsnSac: course.hsnSac.trim() } : {}),
        ...(course.lmsCourseSlug?.trim() ? { lmsCourseSlug: course.lmsCourseSlug.trim() } : {}),
        ...(course.lmsCourseSlugs?.length ? { lmsCourseSlugs: course.lmsCourseSlugs } : {}),
      },
      priceMinor: input.priceMinor,
      currency: invoice.currency ?? "AED",
      reason: input.reason,
      requestedBy: { name: input.requestedBy.name ?? "", email: input.requestedBy.email ?? "" },
    });
  } catch (err) {
    if ((err as { code?: number }).code !== 11000) throw err;
    // The same request twice at once: one made it in; answer with that one.
    const raced = await CourseChangeModel.findOne({ organizationId: org, source: input.source, externalId: input.externalId }).lean();
    if (raced) return courseChangeDTO(raced);
    // Another one for this invoice, sent at the same moment, got in first.
    const other = await CourseChangeModel.findOne({ invoiceId: invoice._id, status: "pending" }).select("course.name").lean();
    throw new AppError("CONFLICT", refusalFor(invoice, input.course.name, input.priceMinor, other ?? {}) ?? "Another course change is already waiting");
  }
  const dto = courseChangeDTO(row.toObject());
  logger.info({ id: dto.id, invoice: dto.invoiceNumber }, "Course change received from a sales CRM");
  void tellApprovers(orgId, dto);
  return dto;
}

export async function getCourseChange(orgId: string, id: string): Promise<CourseChange> {
  if (!Types.ObjectId.isValid(id)) throw new AppError("NOT_FOUND", "Course change not found");
  const row = await CourseChangeModel.findOne({ _id: id, organizationId: new Types.ObjectId(orgId) }).lean();
  if (!row) throw new AppError("NOT_FOUND", "Course change not found");
  const invoice = await Invoice.findById(row.invoiceId).select("totalMinor amountPaidMinor balanceMinor status").lean();
  return courseChangeDTO(row, invoice);
}

/**
 * The course-only path of scripts/enrolment-change.ts: the invoice line, the
 * LMS courses it adds, the enrolment. Each step is safe to run again, so an
 * approval that stopped half-way can simply be approved again.
 */
async function applyCourseChange(orgId: string, invoice: any, row: any): Promise<{ opened: string[] }> {
  const c = row.course ?? {};
  // The catalogue item, where the CRM sent one this organization has; a plain line otherwise.
  const item: any = c.itemId && Types.ObjectId.isValid(c.itemId)
    ? await Item.findOne({ _id: c.itemId, organizationId: invoice.organizationId }).select("_id lmsCourseSlug lmsCourseSlugs").lean()
    : null;
  // The LMS courses: the item's, else the ones the CRM maps the course to — as the close is taken (lmsCoursesForInvoice).
  const declared = (c.lmsCourseSlugs?.length ? c.lmsCourseSlugs : [c.lmsCourseSlug ?? ""]).map((s: string) => String(s).trim()).filter(Boolean);
  const mapped = itemLmsCourses(item);
  const slugs: string[] = [...new Set<string>(mapped.length ? mapped : declared)];

  // 1. The line: the new course at its fee, taxed as before. Its code from the CRM, else the item's or the default.
  const svc = await import("../invoice/invoice.service");
  const taxes = (invoice.lineItems?.[0]?.taxes ?? []).map((t: any) => ({ code: t.code, rate: t.rate }));
  await svc.updateInvoice(orgId, String(invoice._id), {
    lineItems: [{
      description: c.name, quantity: 1, unitPriceMinor: row.priceMinor, discountPct: 0, taxes,
      ...(item ? { itemId: String(item._id) } : {}), ...(c.hsnSac ? { hsnSac: c.hsnSac } : {}),
    }],
  } as never, { all: true });

  // 2. The LMS courses it adds, sent by the provisioning worker. Nothing is closed in the LMS.
  const provision: any = await LmsProvision.findOne({ invoiceId: invoice._id }).select("payload.courseSlug extraCourses.slug").lean();
  const opened = new Set<string>([provision?.payload?.courseSlug, ...(provision?.extraCourses ?? []).map((e: any) => e.slug)].filter(Boolean));
  const toOpen = slugs.filter((s) => !opened.has(s));
  if (provision && toOpen.length) {
    await LmsProvision.updateOne({ _id: provision._id }, { $push: { extraCourses: { $each: toOpen.map((slug) => ({ slug, status: "pending", attempts: 0, nextAttemptAt: new Date() })) } } });
  }

  // 3. The enrolment says the new course.
  await Invoice.updateOne({ _id: invoice._id }, {
    $set: {
      "enrolment.course": c.name,
      "enrolment.courses": [{ name: c.name, lmsCourseSlugs: slugs }],
      ...(slugs[0] ? { "enrolment.lmsCourseSlug": slugs[0] } : {}),
    },
  });

  // A cheaper course may now be paid in full: the LMS opens more (it only ever opens). CS Portal's figures
  // follow the new course name too — updateInvoice queued them before the enrolment said it.
  const after = await Invoice.findById(invoice._id);
  if (after) void svc.syncLmsAccess(after as never);
  void import("../integrations/commission-fee-update.service").then((m) => m.queueFeeUpdate(String(invoice._id), "edit")).catch(() => undefined);
  return { opened: provision ? toOpen : [] };
}

/**
 * Approved: checked again against the invoice as it is now, claimed, then
 * applied and marked so. Rejected: with why. One decision each, whoever gets
 * there first; one that no longer fits is refused, still waiting, for them to
 * reject.
 */
export async function decideCourseChange(auth: AuthContext, id: string, input: DecideCourseChangeInput): Promise<CourseChange> {
  if (!Types.ObjectId.isValid(id)) throw new AppError("NOT_FOUND", "Course change not found");
  const org = new Types.ObjectId(auth.organizationId);
  const row: any = await CourseChangeModel.findOne({ _id: id, organizationId: org }).lean();
  if (!row) throw new AppError("NOT_FOUND", "Course change not found");
  if (row.status !== "pending") throw new AppError("CONFLICT", `This course change is already ${row.status}`);
  const me = await User.findById(auth.userId).select("name").lean();
  const decided = { decidedById: new Types.ObjectId(auth.userId), decidedByName: String(me?.name ?? "Accounts"), decidedAt: new Date() };
  // Nobody is approving it right now: a claim stands until its approval is done or undone.
  const free = { _id: row._id, status: "pending", "decision.decidedAt": { $exists: false } };

  if (input.decision === "rejected") {
    const res = await CourseChangeModel.updateOne(free, { $set: { status: "rejected", decision: { ...decided, reason: input.reason } } });
    if (!res.modifiedCount) throw new AppError("CONFLICT", "Somebody is deciding it just now");
    logger.info({ id, invoice: row.invoiceNumber }, "Course change rejected");
    return getCourseChange(auth.organizationId, id);
  }

  const invoice: any = await Invoice.findOne({ _id: row.invoiceId, organizationId: org }).select(INVOICE_FIELDS).lean();
  const refusal = refusalFor(invoice, row.course?.name ?? "", row.priceMinor);
  if (refusal) throw new AppError("CONFLICT", `Not changed: ${refusal}`);
  // Claimed before it is applied, so two accountants never apply it twice.
  const claim = await CourseChangeModel.updateOne(free, { $set: { decision: decided } });
  if (!claim.modifiedCount) throw new AppError("CONFLICT", "Somebody is deciding it just now");
  let applied: { opened: string[] };
  try {
    applied = await applyCourseChange(auth.organizationId, invoice, row);
  } catch (err) {
    await CourseChangeModel.updateOne({ _id: row._id, status: "pending" }, { $unset: { decision: "" } });
    if (err instanceof AppError) throw new AppError("CONFLICT", `Not changed: ${err.message}`);
    throw err;
  }
  await CourseChangeModel.updateOne({ _id: row._id }, {
    $set: { status: "approved", appliedAt: new Date(), decision: { ...decided, ...(input.note ? { note: input.note } : {}) } },
  });
  logger.info({ id, invoice: row.invoiceNumber, lms: applied.opened }, "Course change approved and applied");
  return getCourseChange(auth.organizationId, id);
}

/** For the CRM, with each enrolment's status: every course change it asked for on these invoices, oldest first. */
export async function courseChangesFor(invoiceIds: unknown[]): Promise<Map<string, any[]>> {
  const out = new Map<string, any[]>();
  if (!invoiceIds.length) return out;
  const rows = await CourseChangeModel.find({ invoiceId: { $in: invoiceIds } }).sort({ createdAt: 1 }).lean();
  for (const r of rows as any[]) {
    const k = String(r.invoiceId);
    if (!out.has(k)) out.set(k, []);
    const decided = r.status !== "pending" && r.decision?.decidedAt;
    out.get(k)!.push({
      externalId: r.externalId,
      status: r.status,
      course: r.course?.name ?? "",
      priceMinor: r.priceMinor,
      currency: r.currency,
      ...(decided && r.decision.reason ? { reason: r.decision.reason } : {}),
      ...(decided ? { decidedAt: iso(r.decision.decidedAt), decidedBy: r.decision.decidedByName ?? "" } : {}),
      ...(decided && r.decision.note ? { note: r.decision.note } : {}),
    });
  }
  return out;
}
