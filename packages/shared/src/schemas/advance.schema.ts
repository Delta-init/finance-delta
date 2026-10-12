import { z } from "zod";

/**
 * Finance's decision on a salary advance HR has approved in HRMS.
 *
 * The amount is HR's and is not changed here: HRMS recovers exactly what was
 * approved, from the employee's pay, on the schedule HR set — an advance paid
 * out at a different figure would be recovered at the wrong one. What finance
 * settles is how the payout is booked: the expense category and, optionally,
 * the department it counts against.
 */

const optionalText = (max: number) => z.string().trim().max(max).optional().default("");

export const approveAdvanceSchema = z.object({
  /** Which linked HRMS organisation the advance is in — the answer goes back there. */
  hrmsOrgId: z.string().trim().min(1, "hrmsOrgId is required"),
  /** A managed expense-category slug. Unused when an expense was already recorded. */
  category: z.string().trim().min(1, "Choose an expense category").optional(),
  /** A finance department, or blank for none. */
  departmentId: z.union([z.literal(""), z.string().regex(/^[a-f\d]{24}$/i, "Invalid department")]).optional().default(""),
  /** Sent back to the employee and HR with the decision. HRMS keeps 500 characters. */
  note: optionalText(500),
});
export type ApproveAdvanceInput = z.infer<typeof approveAdvanceSchema>;
export type ApproveAdvanceBody = z.input<typeof approveAdvanceSchema>;

export const rejectAdvanceSchema = z.object({
  hrmsOrgId: z.string().trim().min(1, "hrmsOrgId is required"),
  note: optionalText(500),
});
export type RejectAdvanceInput = z.infer<typeof rejectAdvanceSchema>;
export type RejectAdvanceBody = z.input<typeof rejectAdvanceSchema>;
