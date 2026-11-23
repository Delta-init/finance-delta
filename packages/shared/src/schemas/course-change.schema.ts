import { z } from "zod";
import { inboundEnrolmentCourseSchema } from "./invoice.schema";

/*
 * A finance-approved enrolment moved to another course, asked for in the sales
 * CRM that closed it (the user, 2026-11-23): a salesperson reopened an approved
 * close, put it on a cheaper course and closed it again, and the invoice never
 * heard — it kept the old course and price. The course of an enrolled student is
 * no longer changed in the CRM; it is asked for here, with the new fee and why,
 * and waits on the Approvals page like a balance payment. Approved, the invoice
 * line, the enrolment and the LMS follow; the CRM reads where it stands with the
 * enrolment's status.
 */

/** A course change as the CRM hands it over. Idempotent on the CRM's own id (`externalId`). */
export const inboundCourseChangeSchema = z.object({
  /** Which CRM — its intake source, as on the enrolment (crm, draw-crm, banglore-crm). */
  source: z.string().trim().min(1).max(40),
  /** The enrolment it changes, by the id the CRM sent it with. */
  enrolmentExternalId: z.string().trim().min(1).max(100),
  /** The CRM's own id for this request: a retry is the same request. */
  externalId: z.string().trim().min(1).max(100),
  /** The new course, exactly as the close sends it — without its amount, which is `priceMinor`. */
  course: inboundEnrolmentCourseSchema.omit({ amountMinor: true }),
  /** The new fee, in minor units. */
  priceMinor: z.number().int().positive().max(9_000_000_000_000),
  reason: z.string().trim().min(3, "Say why the course changes").max(500),
  requestedBy: z.object({ name: z.string().trim().max(120).default(""), email: z.string().trim().max(200).default("") }),
});
export type InboundCourseChange = z.infer<typeof inboundCourseChangeSchema>;

export const courseChangeStatusSchema = z.enum(["pending", "approved", "rejected"]);
export type CourseChangeStatus = z.infer<typeof courseChangeStatusSchema>;

export const decideCourseChangeSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("approved"),
    note: z.string().trim().max(1000).optional(),
  }),
  z.object({
    decision: z.literal("rejected"),
    reason: z.string().trim().min(5, "Give a reason of at least 5 characters").max(1000),
  }),
]);
export type DecideCourseChangeInput = z.infer<typeof decideCourseChangeSchema>;

/** One, as the Approvals page reviews it. */
export const courseChangeSchema = z.object({
  id: z.string(),
  status: courseChangeStatusSchema,
  source: z.string(),
  invoiceId: z.string(),
  invoiceNumber: z.string(),
  customerName: z.string(),
  /** What the enrolment was when it was asked for: its course and the invoice total. */
  fromCourse: z.string(),
  fromPriceMinor: z.number(),
  course: z.object({
    name: z.string(),
    itemId: z.string().optional(),
    hsnSac: z.string().optional(),
    lmsCourseSlug: z.string().optional(),
    lmsCourseSlugs: z.array(z.string()).optional(),
  }),
  priceMinor: z.number(),
  currency: z.string(),
  reason: z.string(),
  requestedBy: z.object({ name: z.string(), email: z.string() }),
  receivedAt: z.string(),
  /** The invoice now: what it comes to, what is paid, what is left — and what would be left at the new fee. */
  invoice: z.object({
    totalMinor: z.number(),
    paidMinor: z.number(),
    balanceMinor: z.number(),
    status: z.string(),
    balanceAfterMinor: z.number(),
  }).optional(),
  decision: z.object({
    decidedByName: z.string(),
    decidedAt: z.string(),
    reason: z.string().optional(),
    note: z.string().optional(),
  }).optional(),
});
export type CourseChange = z.infer<typeof courseChangeSchema>;
