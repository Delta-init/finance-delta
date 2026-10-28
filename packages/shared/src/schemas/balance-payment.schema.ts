import { z } from "zod";
import { PAYMENT_METHODS, storedReceiptSchema } from "./invoice.schema";

/*
 * The next payment of a part-paid enrolment, recorded in the sales CRM that
 * closed it (the user, 2026-10-13): every part-paid course a sales CRM closed
 * is followed up there, by its salesperson, not in CS Portal. Each
 * payment comes with its receipt and waits for accounts here; approved, it is
 * recorded on the invoice; the CRM shows it pending, approved or rejected.
 */

/** A payment as the CRM hands it over. Idempotent on the CRM's own id (`externalId`). */
export const inboundBalancePaymentSchema = z.object({
  /** Which CRM — its intake source, as on the enrolment (crm, draw-crm, banglore-crm). */
  source: z.string().trim().min(1).max(40),
  /** The enrolment it pays towards, by the id the CRM sent it with. */
  enrolmentExternalId: z.string().trim().min(1).max(100),
  /** The CRM's own id for this payment: a retry is the same payment. */
  externalId: z.string().trim().min(1).max(100),
  amountMinor: z.number().int().positive().max(9_000_000_000_000),
  method: z.enum(PAYMENT_METHODS),
  /** The day the money was paid, YYYY-MM-DD. */
  paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "paidOn is YYYY-MM-DD"),
  receipt: storedReceiptSchema,
  note: z.string().trim().max(1000).optional(),
  recordedBy: z.object({ name: z.string().trim().max(120).default(""), email: z.string().trim().max(200).default("") }),
});
export type InboundBalancePayment = z.infer<typeof inboundBalancePaymentSchema>;

export const balancePaymentStatusSchema = z.enum(["pending", "approved", "rejected"]);
export type BalancePaymentStatus = z.infer<typeof balancePaymentStatusSchema>;

export const decideBalancePaymentSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("approved"),
    /** The bank's or gateway's reference, where there is one. */
    reference: z.string().trim().max(100).optional(),
    note: z.string().trim().max(1000).optional(),
  }),
  z.object({
    decision: z.literal("rejected"),
    reason: z.string().trim().min(5, "Give a reason of at least 5 characters").max(1000),
  }),
]);
export type DecideBalancePaymentInput = z.infer<typeof decideBalancePaymentSchema>;

/** One, as the Approvals page reviews it. */
export const balancePaymentSchema = z.object({
  id: z.string(),
  status: balancePaymentStatusSchema,
  source: z.string(),
  invoiceId: z.string(),
  invoiceNumber: z.string(),
  customerName: z.string(),
  course: z.string(),
  amountMinor: z.number(),
  currency: z.string(),
  method: z.string(),
  paidOn: z.string(),
  receipt: z.object({ name: z.string(), url: z.string(), mimeType: z.string().optional() }),
  note: z.string(),
  recordedBy: z.object({ name: z.string(), email: z.string() }),
  receivedAt: z.string(),
  /** The invoice now: what it comes to, what is paid, what is left. */
  invoice: z.object({ totalMinor: z.number(), paidMinor: z.number(), balanceMinor: z.number(), status: z.string() }).optional(),
  decision: z.object({
    decidedByName: z.string(),
    decidedAt: z.string(),
    reason: z.string().optional(),
    reference: z.string().optional(),
    note: z.string().optional(),
    receiptNumber: z.string().optional(),
  }).optional(),
});
export type BalancePayment = z.infer<typeof balancePaymentSchema>;
