import { z } from "zod";
import { expensePaymentMethodSchema } from "./expense.schema";

/**
 * Finance's decision on a salary advance HR has approved in HRMS.
 *
 * Finance may pay a different amount than was asked (2026-11-10): HRMS then keeps
 * the asked one and recovers what was paid, over HR's months — more than asked
 * needs a note. Finance also settles how the payout is booked: the expense
 * category and, optionally, the department it counts against.
 */

const optionalText = (max: number) => z.string().trim().max(max).optional().default("");

export const approveAdvanceSchema = z.object({
  /** Which linked HRMS organisation the advance is in — the answer goes back there. */
  hrmsOrgId: z.string().trim().min(1, "hrmsOrgId is required"),
  /** A managed expense-category slug. Unused when an expense was already recorded. */
  category: z.string().trim().min(1, "Choose an expense category").optional(),
  /** One of the category's subcategories (2026-10-21) — needed when it has any; the page's default fills it. */
  subcategory: z.string().trim().max(60).optional(),
  /** A finance department, or blank for none. */
  departmentId: z.union([z.literal(""), z.string().regex(/^[a-f\d]{24}$/i, "Invalid department")]).optional().default(""),
  /** Sent back to the employee and HR with the decision. HRMS keeps 500 characters. */
  note: optionalText(500),
  /** The day the money went — the expense is recorded as paid on it. */
  paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the date it was paid"),
  paymentMethod: expensePaymentMethodSchema,
  /** The bank or cheque reference, kept on the expense. */
  reference: optionalText(120),
  /** What was paid, in minor units, when it isn't what was asked (2026-11-10). Left out = the amount asked. */
  amountMinor: z.number().int("Enter the amount paid").positive("The amount paid must be more than 0").optional(),
});
export type ApproveAdvanceInput = z.infer<typeof approveAdvanceSchema>;
export type ApproveAdvanceBody = z.input<typeof approveAdvanceSchema>;

export const rejectAdvanceSchema = z.object({
  hrmsOrgId: z.string().trim().min(1, "hrmsOrgId is required"),
  note: optionalText(500),
});
export type RejectAdvanceInput = z.infer<typeof rejectAdvanceSchema>;
export type RejectAdvanceBody = z.input<typeof rejectAdvanceSchema>;

/**
 * A one-time payment HR sent from HRMS for finance to pay directly — a bonus
 * or commission that does not go on the payslip. Marking it paid records a
 * paid expense, the same way a salary advance is; the amount is HR's.
 */
export const markOneTimePaidSchema = approveAdvanceSchema;
export type MarkOneTimePaidInput = ApproveAdvanceInput;
export type MarkOneTimePaidBody = ApproveAdvanceBody;
export const rejectOneTimePaymentSchema = rejectAdvanceSchema;
export type RejectOneTimePaymentInput = RejectAdvanceInput;
export type RejectOneTimePaymentBody = RejectAdvanceBody;
