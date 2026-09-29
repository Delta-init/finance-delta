import { z } from "zod";

/**
 * The money decision on a purchase request HR has approved in HRMS.
 *
 * Approving it records an expense — approved, unpaid — rather than raising a
 * purchase order, so nothing here asks for a vendor: most of these are small
 * buys nobody has chosen a supplier for, and the vendor list is no help with
 * them. What the approver settles is what the expense needs and HR cannot
 * know: the amount finance agrees to, the expense category, and whose
 * department's spend it is.
 *
 * Money in minor units of the request's currency. HR's own figure is an
 * estimate in whole units, and only ever the starting point.
 */

const optionalText = (max: number) => z.string().trim().max(max).optional().default("");

/**
 * Amount and category are needed to record the expense, and only then: when
 * one has already been recorded for the request — HRMS could not be told the
 * first time — approving again resends it as it was made, and they are unused.
 */
export const approveProcurementSchema = z.object({
  /** Which linked HRMS organisation the request is in — the answer goes back there. */
  hrmsOrgId: z.string().trim().min(1, "hrmsOrgId is required"),
  /** An approval of nothing is not a purchase, so 0 is refused rather than recorded. */
  amountMinor: z.number().int("Amount must be in minor units").positive("Enter the amount being approved").max(9_000_000_000_000).optional(),
  /** A managed expense-category slug. */
  category: z.string().trim().min(1, "Choose an expense category").optional(),
  /** What "Other" actually was — the page fills in HR's own category. */
  categoryOther: optionalText(60),
  /** A finance department, or blank for none. */
  departmentId: z.union([z.literal(""), z.string().regex(/^[a-f\d]{24}$/i, "Invalid department")]).optional().default(""),
  /** Sent back to HR with the decision. HRMS keeps 500 characters of it. */
  note: optionalText(500),
});
export type ApproveProcurementInput = z.infer<typeof approveProcurementSchema>;
/** What a caller sends — the defaults above fill in the rest. */
export type ApproveProcurementBody = z.input<typeof approveProcurementSchema>;

export const rejectProcurementSchema = z.object({
  hrmsOrgId: z.string().trim().min(1, "hrmsOrgId is required"),
  note: optionalText(500),
});
export type RejectProcurementInput = z.infer<typeof rejectProcurementSchema>;
export type RejectProcurementBody = z.input<typeof rejectProcurementSchema>;
