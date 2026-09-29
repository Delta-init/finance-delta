import { z } from "zod";
import { listQuerySchema } from "./query.schema";

/**
 * Deposit requests from Tetra Commission, approved here.
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
 */

const optionalText = (max: number) => z.string().trim().max(max).optional().default("");

/** Idempotent on Tetra Commission's own id, so a retry after a timeout is the same request. */
export const inboundTetraDepositSchema = z.object({
  externalId: z.string().trim().min(1).max(64),
  amountMinor: z.number().int().positive().max(9_000_000_000_000),
  currency: z.string().length(3).default("USD").transform((v) => v.toUpperCase()),
  student: z.object({
    id: optionalText(64),
    code: optionalText(40),
    name: z.string().trim().min(1).max(160),
    email: optionalText(200),
    level: optionalText(20),
  }),
  team: optionalText(120),
  paymentMethod: optionalText(60),
  mt5Login: optionalText(60),
  /** The student's trading accounts, offered when approving. */
  mt5Accounts: z.array(z.object({ login: z.string().trim().min(1).max(60), platform: optionalText(40) })).max(20).optional().default([]),
  /** The proof of payment the mentor uploaded — a link, opened from the approval. */
  screenshotUrl: optionalText(1000).refine((v) => !v || /^https?:\/\//i.test(v), "Must be a web address"),
  notes: optionalText(2000),
  requestedAt: optionalText(40),
  requestedBy: optionalText(120),
  initiatingMentor: optionalText(120),
  primaryMentor: optionalText(120),
  meetingMentor: optionalText(120),
});
export type InboundTetraDeposit = z.infer<typeof inboundTetraDepositSchema>;

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
  }),
]);
export type DecideTetraDepositInput = z.infer<typeof decideTetraDepositSchema>;

export const tetraDepositViewSchema = z.enum(["waiting", "attention", "decided"]);
export type TetraDepositView = z.infer<typeof tetraDepositViewSchema>;

export const tetraDepositSchema = z.object({
  id: z.string(),
  externalId: z.string(),
  status: tetraDepositStatusSchema,
  amountMinor: z.number(),
  currency: z.string(),
  student: z.object({ id: z.string(), code: z.string(), name: z.string(), email: z.string(), level: z.string() }),
  team: z.string(),
  paymentMethod: z.string(),
  mt5Login: z.string(),
  mt5Accounts: z.array(z.object({ login: z.string(), platform: z.string() })),
  screenshotUrl: z.string(),
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
    decidedByName: z.string(),
    decidedAt: z.string(),
  }).optional(),
  delivery: z.object({
    state: tetraDepositDeliverySchema,
    attempts: z.number(),
    lastError: z.string().optional(),
    deliveredAt: z.string().optional(),
  }).optional(),
  closedReason: z.string().optional(),
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
