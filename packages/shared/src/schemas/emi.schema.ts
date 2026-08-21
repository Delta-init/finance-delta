import { z } from "zod";

/**
 * Easebuzz EMI payment details.
 *
 * These are *record-only* fields: they capture the terms of an EMI (Equated
 * Monthly Installment) payment made through Easebuzz. No live gateway call is
 * made — the operator enters the details from the Easebuzz dashboard / receipt.
 *
 * Shared between invoice payments (money in) and bill payments (money out).
 */

// ── Input (what the client sends when recording an Easebuzz EMI payment) ──
export const emiDetailInputSchema = z.object({
  /** Issuing bank or EMI provider, e.g. "HDFC Bank", "Bajaj Finserv". */
  bank: z.string().max(120).optional().default(""),
  /** Number of monthly installments. */
  tenureMonths: z.coerce.number().int().min(1, "Tenure must be at least 1 month").max(60),
  /** Amount charged per month, in minor units. */
  monthlyAmountMinor: z.coerce.number().int().min(0).optional().default(0),
  /** Annual interest rate applied by the provider. */
  interestPct: z.coerce.number().min(0).max(100).optional().default(0),
  /** One-time processing fee, in minor units. */
  processingFeeMinor: z.coerce.number().int().min(0).optional().default(0),
  /** Easebuzz transaction / reference id. */
  transactionId: z.string().max(200).optional().default(""),
});
export type EmiDetailInput = z.infer<typeof emiDetailInputSchema>;

// ── Output DTO ──
export const emiDetailSchema = z.object({
  bank: z.string(),
  tenureMonths: z.number(),
  monthlyAmountMinor: z.number(),
  interestPct: z.number(),
  processingFeeMinor: z.number(),
  transactionId: z.string(),
});
export type EmiDetail = z.infer<typeof emiDetailSchema>;
