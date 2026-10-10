import { z } from "zod";
import { ACADEMIES, ENROLMENT_CRMS } from "./invoice.schema";

/**
 * Everything waiting on one approver, across every kind of approval.
 *
 * One answer for the three places that ask — the sidebar counts, the dashboard
 * pop-up and the Approvals page — so they cannot disagree about what is
 * waiting, and so asking costs one call rather than one per kind.
 *
 * Only the kinds the reader may decide are included. A kind that could not be
 * read (procurement lives in HRMS) says so in `unavailable` and counts nothing,
 * rather than reporting a confident zero.
 */
export const approvalTypeSchema = z.enum(["invoice", "fund_request", "tetra_deposit", "expense", "bill", "payroll", "procurement"]);
export type ApprovalType = z.infer<typeof approvalTypeSchema>;

export const approvalItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  subtitle: z.string(),
  amountMinor: z.number().optional(),
  /** An enrolment: its course fee (the invoice total) — `amountMinor` is what was collected. */
  feeMinor: z.number().optional(),
  currency: z.string().optional(),
  /** When it started waiting, ISO. */
  at: z.string().optional(),
  /** Where it is decided. */
  href: z.string(),
});
export type ApprovalItem = z.infer<typeof approvalItemSchema>;

export const approvalGroupSchema = z.object({
  type: approvalTypeSchema,
  label: z.string(),
  count: z.number(),
  /** Where the whole queue of this kind lives. */
  href: z.string(),
  /** The newest few, newest first. */
  items: z.array(approvalItemSchema),
  unavailable: z.string().optional(),
});
export type ApprovalGroup = z.infer<typeof approvalGroupSchema>;

export const approvalSummarySchema = z.object({
  total: z.number(),
  groups: z.array(approvalGroupSchema),
});
export type ApprovalSummary = z.infer<typeof approvalSummarySchema>;

/**
 * Every approval, decided or not, in one list — the Approvals page's table.
 *
 * The summary above answers "what is waiting on me"; this answers that and
 * "what was decided, by whom, and what came of it", across every kind the
 * reader may decide, newest first. A row's `at` is when it last happened to
 * it: when it was decided, or while it waits, when it was sent for a decision.
 * The date range and the newest-first order are both on `at`.
 */
export const approvalListStatusSchema = z.enum(["pending", "approved", "rejected", "all"]);
export type ApprovalListStatus = z.infer<typeof approvalListStatusSchema>;

export const approvalListQuerySchema = z.object({
  status: approvalListStatusSchema.default("pending"),
  type: approvalTypeSchema.optional(),
  /**
   * Instants, not dates, as on the Tetra deposits page: the page turns the days
   * somebody picks into the start of the first and of the day after the last,
   * in their own timezone. `from` is included, `to` is not.
   */
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type ApprovalListQuery = z.infer<typeof approvalListQuerySchema>;

/** Where a row stands. "returned" is an enrolment invoice sent back; "closed" a Tetra deposit closed at Tetra's end. */
export const approvalRowStatusSchema = z.enum(["pending", "approved", "rejected", "returned", "closed"]);
export type ApprovalRowStatus = z.infer<typeof approvalRowStatusSchema>;

/** An approved enrolment's student in the LMS. */
export const approvalLmsSchema = z.object({
  state: z.enum(["waiting", "created", "existing", "failed", "unmapped"]),
  detail: z.string().optional(),
});
export type ApprovalLms = z.infer<typeof approvalLmsSchema>;

/** The same student on Tetra Commission's portal — Forex students only. */
export const approvalCommissionSchema = z.object({
  state: z.enum(["waiting", "created", "existing", "skipped", "failed", "not_sent"]),
  detail: z.string().optional(),
  /** The student's code there, once they have one. */
  code: z.string().optional(),
});
export type ApprovalCommission = z.infer<typeof approvalCommissionSchema>;

export const approvalRowSchema = z.object({
  id: z.string(),
  type: approvalTypeSchema,
  title: z.string(),
  subtitle: z.string(),
  amountMinor: z.number().optional(),
  /** An enrolment: its course fee (the invoice total) — `amountMinor` is what was collected. */
  feeMinor: z.number().optional(),
  currency: z.string().optional(),
  raisedBy: z.string().optional(),
  status: approvalRowStatusSchema,
  /** When it last happened: decided, or while it waits, sent for a decision. ISO. */
  at: z.string().optional(),
  submittedAt: z.string().optional(),
  decidedAt: z.string().optional(),
  decidedBy: z.string().optional(),
  /** Why it was turned down or sent back, where that was written down. */
  reason: z.string().optional(),
  /** Where it is decided, or where it lives once decided. */
  href: z.string(),
  /** Decided on the Approvals page itself (fund requests, Tetra deposits) rather than on a page of its own. */
  decideHere: z.boolean().optional(),
  /** The reader's own request: somebody else decides it. */
  own: z.boolean().optional(),
  /** An enrolment invoice: the sales CRM that sold it. Absent for one typed in finance. */
  crm: z.enum(ENROLMENT_CRMS).optional(),
  /** An enrolment invoice from a sales CRM: the academy it was sold for. */
  academy: z.enum(ACADEMIES).optional(),
  /**
   * An enrolment invoice from a sales CRM: what finance flagged on it to check
   * before deciding — an unmapped course, a rep with no account here, an email
   * that already belongs to another client. Absent when nothing was.
   */
  flags: z.array(z.string()).optional(),
  /** A decided Tetra deposit: whether Tetra Commission has the decision yet. */
  delivery: z.object({ state: z.string(), error: z.string().optional() }).optional(),
  lms: approvalLmsSchema.optional(),
  commission: approvalCommissionSchema.optional(),
});
export type ApprovalRow = z.infer<typeof approvalRowSchema>;
