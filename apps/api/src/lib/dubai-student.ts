import { Types } from "mongoose";
import { enrolmentAcademy, enrolmentCrm } from "@delta/shared";
import { Tag } from "../modules/tag/tag.model";
import { Invoice } from "../modules/invoice/invoice.model";
import { Customer } from "../modules/customer/customer.model";
import { logger } from "./logger";

/*
 * DUBAI-STUD (the user, 2026-11-20): a close from one of the Dubai side's sales CRMs — the Sales CRM, Draw or
 * Remote — that picked the Bangalore academy. Its money is Bangalore's as before (the Bangalore organization's books,
 * in rupees), but the student is a Dubai student: the LMS puts a new one in the Dubai academy and CS Portal gives them
 * to a Dubai team.
 *
 * The tag decides, not the rule: an enrolment tagged DUBAI-STUD is told to the LMS and CS Portal as a Dubai student,
 * whoever tagged it; take the tag off and it is a Bangalore student again. The rule only puts the tag on — at the
 * close, and on a correction.
 */

export const DUBAI_STUD_TAG = "DUBAI-STUD";
const DUBAI_SIDE_CRMS: readonly string[] = ["delta", "draw", "remote"];
/** Any spelling of the tag's name an organization has — typed by hand as "dubai-stud", it still counts. */
const NAME = /^dubai-stud$/i;

/** Sold by the Dubai side's CRMs for the Bangalore academy. */
export function soldAsDubaiStudent(crm: string | null | undefined, academy: string | null | undefined): boolean {
  return !!crm && DUBAI_SIDE_CRMS.includes(crm) && academy === "bangalore";
}

/** The organization's DUBAI-STUD tag, made the first time one is needed. */
export async function dubaiStudTagId(orgId: string | Types.ObjectId, create: boolean): Promise<Types.ObjectId | null> {
  const organizationId = new Types.ObjectId(String(orgId));
  const found = await Tag.findOne({ organizationId, name: NAME }).sort({ createdAt: 1 }).select("_id").lean<{ _id: Types.ObjectId } | null>();
  if (found || !create) return found?._id ?? null;
  try {
    const made = await Tag.create({ organizationId, name: DUBAI_STUD_TAG, color: "amber" });
    return made._id as Types.ObjectId;
  } catch (err) {
    // Made at the same moment by another close (the name is unique per organization).
    const again = await Tag.findOne({ organizationId, name: NAME }).select("_id").lean<{ _id: Types.ObjectId } | null>();
    if (again) return again._id;
    throw err;
  }
}

/**
 * Put the tag on an enrolment invoice and its client when the close was a Dubai student's — nothing otherwise, and
 * never taken off here (somebody may have put it on by hand). Answers whether it is tagged now.
 */
export async function tagIfDubaiStudent(orgId: string, invoiceId: string): Promise<boolean> {
  const invoice = await Invoice.findOne({ _id: new Types.ObjectId(invoiceId), organizationId: new Types.ObjectId(orgId) })
    .select("customerId enrolment.crm enrolment.academy external.source")
    .lean<{ customerId?: Types.ObjectId; enrolment?: { crm?: string; academy?: string }; external?: { source?: string } } | null>();
  if (!invoice) return false;
  const crm = enrolmentCrm(invoice.enrolment?.crm, invoice.external?.source);
  if (!soldAsDubaiStudent(crm, enrolmentAcademy(invoice.enrolment?.academy, crm))) return false;
  await tagDubaiStudent(orgId, invoiceId, invoice.customerId ? String(invoice.customerId) : null);
  return true;
}

/** The tag on the invoice and on its client (each once). */
export async function tagDubaiStudent(orgId: string, invoiceId: string, customerId: string | null): Promise<Types.ObjectId> {
  const organizationId = new Types.ObjectId(orgId);
  const tagId = (await dubaiStudTagId(orgId, true))!;
  await Invoice.updateOne({ _id: new Types.ObjectId(invoiceId), organizationId }, { $addToSet: { tagIds: tagId } });
  if (customerId) await Customer.updateOne({ _id: new Types.ObjectId(customerId), organizationId }, { $addToSet: { tagIds: tagId } });
  return tagId;
}

/** Whether the enrolment on this invoice is tagged DUBAI-STUD now — read when it is sent to the LMS or CS Portal. */
export async function isDubaiStudent(invoiceId: unknown): Promise<boolean> {
  if (!invoiceId || !Types.ObjectId.isValid(String(invoiceId))) return false;
  const invoice = await Invoice.findById(invoiceId).select("organizationId tagIds").lean<{ organizationId?: Types.ObjectId; tagIds?: Types.ObjectId[] } | null>();
  if (!invoice?.organizationId || !invoice.tagIds?.length) return false;
  const tags = await Tag.find({ organizationId: invoice.organizationId, name: NAME }).select("_id").lean<Array<{ _id: Types.ObjectId }>>();
  return invoice.tagIds.some((t) => tags.some((x) => String(x._id) === String(t)));
}

/**
 * `{ dubaiStudent: true }` for a tagged enrolment, else nothing — spread into what is sent. A failure to read it is
 * thrown, so the send is tried again later rather than made without it (a Dubai student put in Bangalore).
 */
export async function dubaiStudentField(invoiceId: unknown): Promise<{ dubaiStudent?: true }> {
  return (await isDubaiStudent(invoiceId)) ? { dubaiStudent: true } : {};
}

/** The tag put on after a close or correction; a failure is logged, not thrown — the enrolment is already made. */
export async function tagIfDubaiStudentQuietly(orgId: string, invoiceId: string): Promise<void> {
  try {
    if (await tagIfDubaiStudent(orgId, invoiceId)) logger.info({ orgId, invoiceId }, "Enrolment tagged DUBAI-STUD");
  } catch (err) {
    logger.error({ orgId, invoiceId, err: (err as Error).message }, "Could not tag the enrolment DUBAI-STUD — the backfill (backfill:dubai-stud) puts it on");
  }
}

/** The tag kept on through a correction (the invoice and its client now); a failure is logged, not thrown. */
export async function tagDubaiStudentQuietly(orgId: string, invoiceId: string, customerId: string | null): Promise<void> {
  try {
    await tagDubaiStudent(orgId, invoiceId, customerId || null);
  } catch (err) {
    logger.error({ orgId, invoiceId, err: (err as Error).message }, "Could not keep the DUBAI-STUD tag through a correction — put it back on the invoice by hand");
  }
}
