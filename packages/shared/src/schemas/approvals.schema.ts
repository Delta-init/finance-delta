import { z } from "zod";

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
