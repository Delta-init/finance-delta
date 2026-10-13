import { enrolmentCrm } from "@delta/shared";
import { Customer } from "../customer/customer.model";
import { Invoice } from "../invoice/invoice.model";
import { LMS_SOURCES } from "../invoice/invoice.service";

/**
 * Where each student's enrolment requests stand in finance — for the LMS
 * admin's Students Requests page (POST /api/v1/lms/enrolment-status).
 *
 * Per email: whether finance knows the student at all (the customer-check
 * rule: a customer with this email, in any organization, not archived), and
 * the enrolments a sales CRM handed over for them — the same invoices that
 * reach the LMS on approval (an `enrolment`, from one of LMS_SOURCES) —
 * newest first, with where accounts got to on each: waiting, approved, or
 * sent back and why. A voided invoice is no request at all.
 *
 * Read-only, and narrow on purpose: which CRM sold it, who closed it, the
 * course and the approval. No money, nothing else of the ledger.
 */

/** At most this many requests per email, newest first. */
export const REQUESTS_PER_EMAIL = 10;

export interface LmsEnrolmentRequest {
  invoiceNumber: string;
  /** enrolment.crm, or worked out from the source (enrolmentCrm); "" when neither says. */
  crm: string;
  /** The CRM rep who closed it, as the close named them (enrolment.meetingBy); "" if none. */
  closedBy: string;
  course: string;
  approval: "pending" | "approved" | "returned";
  /** "" unless returned. */
  returnedReason: string;
  /** ISO — the invoice's issue date (the day of the close), else when it was created. */
  at: string;
}

export interface LmsEmailStatus {
  inFinance: boolean;
  requests: LmsEnrolmentRequest[];
}

type CustomerRow = { _id: unknown; email?: string; status?: string };
type InvoiceRow = {
  customerId: unknown;
  invoiceNumber?: string;
  issueDate?: Date;
  createdAt?: Date;
  approval?: { state?: string; returnedReason?: string };
  external?: { source?: string };
  enrolment?: { crm?: string; course?: string; meetingBy?: string };
};

/**
 * pending and returned as they are. "approved" for approved — and for
 * "not_required" or no approval block at all, which on a CRM enrolment can
 * only be one from before approvals existed: nothing is holding it.
 */
function approvalOf(state: string | undefined): LmsEnrolmentRequest["approval"] {
  if (state === "pending") return "pending";
  if (state === "returned") return "returned";
  return "approved";
}

const iso = (d: unknown): string => {
  if (!d) return "";
  const t = new Date(d as string);
  return Number.isNaN(t.getTime()) ? "" : t.toISOString();
};

/**
 * `emails` already trimmed, lowercased and valid. Every one gets a key, found
 * or not. One customer query and one invoice query for the whole batch.
 */
export async function lmsEnrolmentStatuses(emails: string[]): Promise<Record<string, LmsEmailStatus>> {
  const results: Record<string, LmsEmailStatus> = {};
  for (const email of emails) results[email] = { inFinance: false, requests: [] };
  if (!emails.length) return results;

  // Every customer with one of these emails, archived too: a request made
  // before somebody archived the customer is still where it got to. Only the
  // ones not archived make the student "in finance" (customer-check's rule).
  const customers = await Customer.find({ email: { $in: emails } })
    .select("_id organizationId email status")
    .lean<(CustomerRow & { organizationId: unknown })[]>();
  const emailOf = new Map<string, string>();
  for (const c of customers) {
    const email = String(c.email ?? "");
    if (!results[email]) continue;
    emailOf.set(String(c._id), email);
    if (c.status !== "archived") results[email].inFinance = true;
  }
  if (!customers.length) return results;

  const invoices = await Invoice.find({
    // organizationId too, so the { organizationId, customerId } index serves it.
    organizationId: { $in: [...new Set(customers.map((c) => String(c.organizationId)))] },
    customerId: { $in: customers.map((c) => c._id) },
    enrolment: { $exists: true, $ne: null },
    "external.source": { $in: [...LMS_SOURCES] },
    status: { $ne: "void" },
  })
    .select("customerId invoiceNumber issueDate createdAt approval external.source enrolment.crm enrolment.course enrolment.meetingBy")
    .sort({ issueDate: -1, createdAt: -1, _id: -1 })
    .lean<InvoiceRow[]>();

  for (const i of invoices) {
    const email = emailOf.get(String(i.customerId));
    if (!email) continue;
    const bucket = results[email]!.requests;
    if (bucket.length >= REQUESTS_PER_EMAIL) continue;
    const approval = approvalOf(i.approval?.state);
    bucket.push({
      invoiceNumber: i.invoiceNumber ?? "",
      crm: enrolmentCrm(i.enrolment?.crm, i.external?.source) ?? "",
      closedBy: (i.enrolment?.meetingBy ?? "").trim(),
      course: i.enrolment?.course ?? "",
      approval,
      returnedReason: approval === "returned" ? i.approval?.returnedReason ?? "" : "",
      at: iso(i.issueDate) || iso(i.createdAt),
    });
  }
  return results;
}
