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

export const budgetSummaryRowSchema = z.object({
  departmentId: z.string(),
  departmentName: z.string(),
  period: periodSchema,
  currency: z.string(),
  allocatedMinor: z.number(),
  approvedRequestsMinor: z.number(),
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
  requestedById: z.string(),
  requestedByName: z.string(),
  requestedAt: z.string(),
  reviewedByName: z.string().optional(),
  reviewedAt: z.string().optional(),
  reviewNote: z.string().optional(),
});
export type FundingRequest = z.infer<typeof fundingRequestSchema>;
