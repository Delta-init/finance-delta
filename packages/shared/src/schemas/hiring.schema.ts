import { z } from "zod";

/**
 * Finance's decision on a hiring request HR has approved in HRMS (2026-10-15).
 *
 * HRMS asks finance about a request whose cost is not already in the budget —
 * new headcount, or a replacement paid more than the person leaving — once HR
 * has approved it. Finance approves it (recruiting may start) or rejects it,
 * with a note the raiser is told. Nothing is booked: a role is not spending
 * until somebody is hired.
 */
export const approveHiringSchema = z.object({
  /** Which linked HRMS organisation the request is in — the answer goes back there. */
  hrmsOrgId: z.string().trim().min(1, "hrmsOrgId is required"),
  note: z.string().trim().max(500).optional().default(""),
});
export type ApproveHiringInput = z.infer<typeof approveHiringSchema>;
export type ApproveHiringBody = z.input<typeof approveHiringSchema>;

export const rejectHiringSchema = z.object({
  hrmsOrgId: z.string().trim().min(1, "hrmsOrgId is required"),
  /** Why — the raiser is told. */
  note: z.string().trim().min(3, "Say why it is rejected").max(500),
});
export type RejectHiringInput = z.infer<typeof rejectHiringSchema>;
export type RejectHiringBody = z.input<typeof rejectHiringSchema>;
