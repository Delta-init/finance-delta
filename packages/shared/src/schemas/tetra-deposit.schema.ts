import { z } from "zod";
import { listQuerySchema } from "./query.schema";

/**
 * Deposit and bonus requests from Tetra Commission, approved here.
 *
 * A mentor there raises a deposit for a student; Tetra Commission hands it
 * over through the signed integration API the moment it is raised. An
 * accountant approves it — at the amount that actually arrived, with the
 * transaction ID it arrived under — or rejects it with a reason, and the
 * decision goes straight back to Tetra Commission, where the request changes
 * and the mentors' commission is credited. Nothing is posted to the books here.
 *
 * Money in cents of the request's currency, which is USD: Tetra Commission
 * keeps its deposits in dollars.
 *
 * A BONUS is a course payment (the user, 2026-10-04): the money in, and what it
 * earns the student in MT5 — `coursePayment`. Approving one here confirms the
 * payment; a broker admin in Tetra Commission then credits the bonus and
 * approves it there, which is the second of its two approvals.
 */

const optionalText = (max: number) => z.string().trim().max(max).optional().default("");
const optionalAmount = z.number().finite().nullable().optional().default(null);

/**
 * DEPOSIT and BONUS are funding requests. COURSE_UPGRADE (2026-10-07) is one
 * payment towards a student's CSE course upgrade, in AED, with its receipt:
 * approving it confirms the money; Tetra Commission then counts it towards the
 * course and raises the MT5 bonus it earns.
 */
/*
 * ENROLMENT_PAYMENT (2026-10-11) is the next payment of a partial enrolment's
 * balance, recorded by the student's CS in Tetra Commission with its receipt:
 * approving it records the payment on that invoice here (as recordPayment
 * does), which sets the next due date and sends Tetra Commission the new
 * figures.
 */
export const tetraDepositTypeSchema = z.enum(["DEPOSIT", "BONUS", "COURSE_UPGRADE", "ENROLMENT_PAYMENT"]);
export type TetraDepositType = z.infer<typeof tetraDepositTypeSchema>;

/** A bonus's course payment, as Tetra Commission worked it out at the request (amounts in AED, the bonus in USD). */
export const tetraCoursePaymentSchema = z.object({
  product: optionalText(160),
  /** "full" or "partial" payment of the course; "" when it did not say. */
  kind: z.enum(["full", "partial", ""]).optional().default(""),
  withBonus: z.boolean().optional().default(false),
  bonusUsd: optionalAmount,
  holdAed: optionalAmount,
  balanceAed: optionalAmount,
  paidTodayAed: optionalAmount,
  paidBeforeAed: optionalAmount,
  price: optionalAmount,
  priceCurrency: optionalText(3),
  /** A course upgrade's id in Tetra Commission — every payment of one upgrade goes on one invoice here (the user, 2026-10-12). */
  upgradeId: optionalText(40),
  /** The day the money was paid (YYYY-MM-DD), where Tetra Commission has it — the payment's date here. */
  paidOn: optionalText(10),
});
export type TetraCoursePayment = z.infer<typeof tetraCoursePaymentSchema>;

/**
 * One payment of a request paid more than one way (the user, 2026-10-06): part
 * by card and part in cash, each with its own method, amount and receipt — as
 * Tetra Commission takes them, the way the sales CRMs do at a close. In cents
 * of the currency the mentor typed (AED, USD or INR); together they come to
 * the amount as typed. `paymentMethod` and `screenshotUrl` are the first one's.
 */
export const tetraDepositPaymentSchema = z.object({
  method: z.string().trim().min(1).max(60),
  amountMinor: z.number().int().positive().max(9_000_000_000_000),
  currency: z.string().length(3).transform((v) => v.toUpperCase()),
  receiptUrl: optionalText(1000).refine((v) => !v || /^https?:\/\//i.test(v), "Must be a web address"),
  receiptName: optionalText(200),
});
export type TetraDepositPayment = z.infer<typeof tetraDepositPaymentSchema>;

const isoDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}/, "Must be a date (YYYY-MM-DD)").transform((v) => v.slice(0, 10));

/**
 * A balance payment's own facts (type ENROLMENT_PAYMENT): the invoice it pays
 * towards — finance's id, which Tetra Commission was given with the student —
 * how and when the client paid, the receipt, and the CS who recorded it.
 */
export const tetraEnrolmentPaymentSchema = z.object({
  invoiceId: z.string().trim().regex(/^[a-f0-9]{24}$/i, "Must be the finance invoice id"),
  invoiceNumber: optionalText(40),
  method: optionalText(60),
  paidOn: isoDate,
  receiptUrl: optionalText(1000).refine((v) => !v || /^https?:\/\//i.test(v), "Must be a web address"),
  receiptName: optionalText(200),
  cs: z.object({ name: optionalText(120), email: optionalText(200) }).optional().default({ name: "", email: "" }),
});
export type TetraEnrolmentPayment = z.infer<typeof tetraEnrolmentPaymentSchema>;

/**
 * Tetra Commission may send a balance payment's facts flat beside the rest
 * (invoiceId, method, paidOn, receiptUrl, csName / csEmail or cs) rather than
 * under `enrolmentPayment`: gathered into it here, so either shape is taken.
 */
function gatherEnrolmentPayment(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const r = raw as Record<string, any>;
  if (r.type !== "ENROLMENT_PAYMENT" || (r.enrolmentPayment && typeof r.enrolmentPayment === "object")) return raw;
  const cs = r.cs && typeof r.cs === "object" ? r.cs : { name: r.csName ?? r.cs_name ?? "", email: r.csEmail ?? r.cs_email ?? "" };
  return {
    ...r,
    enrolmentPayment: {
      invoiceId: r.invoiceId ?? r.invoice_id,
      invoiceNumber: r.invoiceNumber ?? r.invoice_number,
      method: r.method ?? r.paymentMethod,
      paidOn: r.paidOn ?? r.paid_on,
      receiptUrl: r.receiptUrl ?? r.receipt_url ?? r.screenshotUrl,
      receiptName: r.receiptName ?? r.receipt_name,
      cs,
    },
  };
}

/** Idempotent on Tetra Commission's own id, so a retry after a timeout is the same request. */
const inboundTetraDepositObject = z.object({
  externalId: z.string().trim().min(1).max(64),
  /** Absent from a Tetra Commission from before bonuses came here: a deposit. */
  type: tetraDepositTypeSchema.optional().default("DEPOSIT"),
  amountMinor: z.number().int().positive().max(9_000_000_000_000),
  currency: z.string().length(3).default("USD").transform((v) => v.toUpperCase()),
  /** The amount as the mentor typed it, when that was another currency (AED) — for the accountant to match. */
  amountOriginal: z.number().positive().max(90_000_000_000).optional(),
  amountCurrency: z.string().length(3).optional().transform((v) => v?.toUpperCase()),
  coursePayment: tetraCoursePaymentSchema.optional(),
  student: z.object({
    id: optionalText(64),
    code: optionalText(40),
    name: z.string().trim().min(1).max(160),
    email: optionalText(200),
    level: optionalText(20),
    /** For the client a course payment is invoiced to, when finance has none with this email yet. */
    phone: optionalText(40),
  }),
  team: optionalText(120),
  paymentMethod: optionalText(60),
  mt5Login: optionalText(60),
  /** The student's trading accounts, offered when approving. */
  mt5Accounts: z.array(z.object({ login: z.string().trim().min(1).max(60), platform: optionalText(40) })).max(20).optional().default([]),
  /** The proof of payment the mentor uploaded — a link, opened from the approval. */
  screenshotUrl: optionalText(1000).refine((v) => !v || /^https?:\/\//i.test(v), "Must be a web address"),
  /**
   * Paid more than one way: each payment with its receipt. Absent from a Tetra
   * Commission from before, and for one payment. A list that cannot be read is
   * dropped — never the deposit with it (the notes say every payment too).
   */
  payments: z.array(tetraDepositPaymentSchema).max(10).optional().default([]).catch([]),
  notes: optionalText(2000),
  /**
   * A request corrected and sent again in Tetra Commission after it was sent
   * back (or rejected) here (the user, 2026-10-13): its earlier request's id
   * there, and the reason it was given.
   */
  resubmitOf: optionalText(64),
  resubmitReason: optionalText(1000),
  requestedAt: optionalText(40),
  requestedBy: optionalText(120),
  initiatingMentor: optionalText(120),
  primaryMentor: optionalText(120),
  meetingMentor: optionalText(120),
  /** A balance payment's facts — required for, and only kept on, type ENROLMENT_PAYMENT. */
  enrolmentPayment: tetraEnrolmentPaymentSchema.optional(),
});
export const inboundTetraDepositSchema = z.preprocess(
  gatherEnrolmentPayment,
  inboundTetraDepositObject.superRefine((v, ctx) => {
    if (v.type === "ENROLMENT_PAYMENT" && !v.enrolmentPayment) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["enrolmentPayment"], message: "A balance payment needs the invoice, the date it was paid and the method" });
    }
  }),
);
export type InboundTetraDeposit = z.infer<typeof inboundTetraDepositObject>;

/**
 * pending   waiting for an accountant
 * approved  / rejected — decided here, and sent back to Tetra Commission
 * closed    nothing left to decide: gone from Tetra Commission, or decided there
 */
export const tetraDepositStatusSchema = z.enum(["pending", "approved", "rejected", "closed"]);
export type TetraDepositStatus = z.infer<typeof tetraDepositStatusSchema>;

/**
 * Getting the decision back to Tetra Commission.
 *
 * sending    being sent right now
 * queued     not reached yet — tried again on its own
 * delivered  Tetra Commission has it
 * failed     refused, for a reason that will not change by trying again
 *            (a transaction ID already used there): reopen it and decide again
 */
export const tetraDepositDeliverySchema = z.enum(["sending", "queued", "delivered", "failed"]);
export type TetraDepositDelivery = z.infer<typeof tetraDepositDeliverySchema>;

export const decideTetraDepositSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("approved"),
    /** What actually arrived — the accountant may correct the requested amount. */
    amountMinor: z.number().int().positive().max(9_000_000_000_000),
    transactionId: z.string().trim().min(1, "The transaction ID is required").max(100),
    paymentMethod: optionalText(60),
    mt5Login: optionalText(60),
    note: optionalText(1000),
  }),
  z.object({
    decision: z.literal("rejected"),
    reason: z.string().trim().min(5, "Give a reason of at least 5 characters").max(1000),
    /**
     * Sent back to correct, like an invoice (the user, 2026-10-13): a bonus the
     * CS fixes in Tetra Commission and sends again — rather than refused.
     */
    sentBack: z.boolean().optional(),
  }),
]);
export type DecideTetraDepositInput = z.infer<typeof decideTetraDepositSchema>;

export const tetraDepositViewSchema = z.enum(["waiting", "attention", "decided"]);
export type TetraDepositView = z.infer<typeof tetraDepositViewSchema>;

export const tetraDepositSchema = z.object({
  id: z.string(),
  externalId: z.string(),
  type: tetraDepositTypeSchema,
  status: tetraDepositStatusSchema,
  amountMinor: z.number(),
  currency: z.string(),
  amountOriginal: z.number().optional(),
  amountCurrency: z.string().optional(),
  coursePayment: tetraCoursePaymentSchema.optional(),
  student: z.object({ id: z.string(), code: z.string(), name: z.string(), email: z.string(), level: z.string() }),
  team: z.string(),
  paymentMethod: z.string(),
  mt5Login: z.string(),
  mt5Accounts: z.array(z.object({ login: z.string(), platform: z.string() })),
  screenshotUrl: z.string(),
  /** Paid more than one way: each payment with its receipt; empty for one payment (paymentMethod, screenshotUrl). */
  payments: z.array(z.object({ method: z.string(), amountMinor: z.number(), currency: z.string(), receiptUrl: z.string(), receiptName: z.string() })),
  notes: z.string(),
  requestedAt: z.string(),
  requestedBy: z.string(),
  initiatingMentor: z.string(),
  primaryMentor: z.string(),
  meetingMentor: z.string(),
  receivedAt: z.string(),
  decision: z.object({
    approvedAmountMinor: z.number().optional(),
    transactionId: z.string().optional(),
    paymentMethod: z.string().optional(),
    mt5Login: z.string().optional(),
    note: z.string().optional(),
    reason: z.string().optional(),
    /** Rejected to be corrected and sent again, not refused. */
    sentBack: z.boolean().optional(),
    decidedByName: z.string(),
    decidedAt: z.string(),
  }).optional(),
  /** Sent again after the request it replaces was sent back or rejected: its reason, and that request here when it came through finance. */
  resubmit: z.object({ reason: z.string(), previousId: z.string().optional(), previousStatus: z.string().optional() }).optional(),
  delivery: z.object({
    state: tetraDepositDeliverySchema,
    attempts: z.number(),
    lastError: z.string().optional(),
    deliveredAt: z.string().optional(),
  }).optional(),
  closedReason: z.string().optional(),
  /**
   * A balance payment's facts, with the invoice as it stood when it arrived
   * (`invoice`), and — once approved — the payment it became (`recorded`).
   */
  enrolmentPayment: z.object({
    invoiceId: z.string(),
    invoiceNumber: z.string(),
    method: z.string(),
    paidOn: z.string(),
    receiptUrl: z.string(),
    receiptName: z.string(),
    cs: z.object({ name: z.string(), email: z.string() }),
    invoice: z.object({
      course: z.string(), customerName: z.string(), currency: z.string(),
      totalMinor: z.number(), paidMinor: z.number(), balanceMinor: z.number(), dueDate: z.string(),
    }).optional(),
    recorded: z.object({ paymentId: z.string(), at: z.string(), method: z.string() }).optional(),
  }).optional(),
  /**
   * A course payment (a course upgrade's, or a bonus's course payment) once approved: the
   * invoice it was recorded on — made for it, or the student's open one for the course —
   * the payment and its receipt (the user, 2026-10-12).
   */
  courseInvoice: z.object({
    invoiceId: z.string(),
    invoiceNumber: z.string(),
    paymentId: z.string(),
    receiptNumber: z.string(),
    amountMinor: z.number(),
    currency: z.string(),
    created: z.boolean(),
  }).optional(),
  /** What happened to it here, oldest first — on a single deposit only. */
  events: z.array(z.object({ at: z.string(), kind: z.string(), byName: z.string(), text: z.string() })).optional(),
});
export type TetraDeposit = z.infer<typeof tetraDepositSchema>;

/**
 * The Tetra Commission deposits page: every request, whatever became of it.
 *
 * `from` and `to` are instants, not dates: the page turns the days somebody
 * picks into the start of the first and the start of the day after the last,
 * in their own timezone, so "the 29th" means their 29th. Compared with when
 * the deposit was raised.
 */
export const tetraDepositListStatusSchema = z.enum(["all", "pending", "approved", "rejected", "closed"]);
export type TetraDepositListStatus = z.infer<typeof tetraDepositListStatusSchema>;

export const tetraDepositListQuerySchema = listQuerySchema.extend({
  status: tetraDepositListStatusSchema.default("all"),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
export type TetraDepositListQuery = z.infer<typeof tetraDepositListQuerySchema>;

/** How many there are of each, under the same search and dates — the page's tab counts. */
export type TetraDepositCounts = Record<TetraDepositListStatus, number>;

/** What deciding one answers: the deposit, and whether Tetra Commission has the decision yet. */
export const tetraDepositDecisionResultSchema = z.object({
  deposit: tetraDepositSchema,
  delivered: z.boolean(),
  message: z.string(),
});
export type TetraDepositDecisionResult = z.infer<typeof tetraDepositDecisionResultSchema>;
