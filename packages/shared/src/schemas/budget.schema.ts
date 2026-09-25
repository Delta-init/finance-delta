import { z } from "zod";

const periodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use a valid month (YYYY-MM)");

export const budgetQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2200).optional(),
  month: periodSchema.optional(),
  departmentId: z.string().regex(/^[a-f\d]{24}$/i, "Invalid department").optional(),
});
export type BudgetQuery = z.infer<typeof budgetQuerySchema>;

export const upsertBudgetAllocationSchema = z.object({
  departmentId: z.string().min(1),
  period: periodSchema,
  currency: z.string().length(3).default("AED").transform((v) => v.toUpperCase()),
  allocatedMinor: z.number().int().min(0).max(9_000_000_000_000),
  note: z.string().max(500).optional().default(""),
});
export type UpsertBudgetAllocationInput = z.infer<typeof upsertBudgetAllocationSchema>;

export const createFundingRequestSchema = z.object({
  period: periodSchema,
  amountMinor: z.number().int().positive().max(9_000_000_000_000),
  title: z.string().trim().min(3).max(120),
  purpose: z.string().trim().min(10).max(2000),
  currency: z.string().length(3).default("AED").transform((v) => v.toUpperCase()),
});
export type CreateFundingRequestInput = z.infer<typeof createFundingRequestSchema>;

export const reviewFundingRequestSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  note: z.string().trim().max(1000).optional().default(""),
}).superRefine((value, ctx) => {
  if (value.decision === "rejected" && value.note.length < 5) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["note"], message: "A rejection reason of at least 5 characters is required" });
  }
});
export type ReviewFundingRequestInput = z.infer<typeof reviewFundingRequestSchema>;

export const fundingRequestStatusSchema = z.enum(["submitted", "approved", "rejected"]);
export type FundingRequestStatus = z.infer<typeof fundingRequestStatusSchema>;

/**
 * Which way an approved request moves a department's month.
 *
 * A top-up is a department asking for more than it was allocated, and adds to
 * what it has. A drawdown is money released out of the allocation it already
 * has — Media ERP asking for ad spend against Marketing's budget — and comes
 * off it. Everything raised inside finance is a top-up, as it always was.
 */
export const fundingRequestKindSchema = z.enum(["topup", "drawdown"]);
export type FundingRequestKind = z.infer<typeof fundingRequestKindSchema>;

/**
 * A fund request handed over by another system (Media ERP) through the signed
 * integration API. Always a drawdown: a calling system spends a department's
 * allocation, it does not get to raise it.
 *
 * Idempotent on the caller's own id, so a retry after a timeout cannot put the
 * same request in front of an approver twice.
 */
export const inboundFundingRequestSchema = z.object({
  source: z.string().trim().min(2).max(40),
  externalId: z.string().trim().min(1).max(100),
  departmentId: z.string().regex(/^[a-f\d]{24}$/i, "Invalid department"),
  period: periodSchema,
  currency: z.string().length(3).default("AED").transform((v) => v.toUpperCase()),
  amountMinor: z.number().int().positive().max(9_000_000_000_000),
  title: z.string().trim().min(3).max(120),
  purpose: z.string().trim().min(10).max(2000),
  platform: z.string().trim().max(60).optional().default(""),
  requestedBy: z.object({
    name: z.string().trim().min(1).max(120),
    // Lenient on purpose: the requester is a person in another system, and a
    // missing address there must not stop the request reaching an approver.
    email: z.string().trim().max(200).optional().default(""),
  }),
});
export type InboundFundingRequest = z.infer<typeof inboundFundingRequestSchema>;

export const budgetSummaryRowSchema = z.object({
  departmentId: z.string(),
  departmentName: z.string(),
  period: periodSchema,
  currency: z.string(),
  allocatedMinor: z.number(),
  approvedRequestsMinor: z.number(),
  approvedDrawdownsMinor: z.number(),
  approvedExpensesMinor: z.number(),
  availableMinor: z.number(),
  pendingRequests: z.number(),
});
export type BudgetSummaryRow = z.infer<typeof budgetSummaryRowSchema>;

export const budgetAllocationChangeSchema = z.object({
  allocatedMinor: z.number(),
  note: z.string(),
  changedByName: z.string(),
  changedAt: z.string(),
});
export type BudgetAllocationChange = z.infer<typeof budgetAllocationChangeSchema>;

export const budgetAllocationSchema = z.object({
  id: z.string(),
  departmentId: z.string(),
  departmentName: z.string(),
  period: periodSchema,
  currency: z.string(),
  allocatedMinor: z.number(),
  note: z.string(),
  updatedByName: z.string(),
  updatedAt: z.string(),
  changes: z.array(budgetAllocationChangeSchema).default([]),
});
export type BudgetAllocation = z.infer<typeof budgetAllocationSchema>;

export const fundingRequestSchema = z.object({
  id: z.string(),
  departmentId: z.string(),
  departmentName: z.string(),
  period: periodSchema,
  currency: z.string(),
  amountMinor: z.number(),
  title: z.string(),
  purpose: z.string(),
  status: fundingRequestStatusSchema,
  kind: fundingRequestKindSchema,
  // "finance" when raised here; otherwise the system that handed it over.
  source: z.string(),
  platform: z.string(),
  requestedById: z.string(),
  requestedByName: z.string(),
  requestedByEmail: z.string().optional(),
  requestedAt: z.string(),
  reviewedByName: z.string().optional(),
  reviewedAt: z.string().optional(),
  reviewNote: z.string().optional(),
});
export type FundingRequest = z.infer<typeof fundingRequestSchema>;
