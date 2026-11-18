import { z } from "zod";

/*
 * The payment reference (the user, 2026-11-18: "when we approve in finance we need to enter the payment reference … a
 * unique code … mandatory"): the bank's or gateway's code for the money — a UTR, a transfer reference, a card slip's
 * authorisation, a Tabby / Tamara order id. Wherever finance records money it is required, except for cash, which has
 * none.
 *
 * Money coming in (a client's payment on an invoice) must also be unique in the organisation — the same transfer
 * can't be counted twice; the API refuses one already on a payment, saying which. Money going out (a payout, a bill,
 * payroll) may repeat: one bank transfer often pays several at once.
 */

/** Whether a payment by this method needs a reference — every method but cash. */
export const referenceNeeded = (method: string | null | undefined): boolean => method !== "cash";

export const REFERENCE_NEEDED_MESSAGE = "Enter the payment reference — the bank or gateway's code for this payment (not needed for cash)";

/** A reference as compared: case and spaces don't count — "UTR 1234" is "utr1234". */
export const normalizeReference = (v: unknown): string => String(v ?? "").toUpperCase().replace(/\s+/g, "");

/** The problem with a reference for this method, or null when it will do. */
export function referenceProblem(method: string | null | undefined, reference: unknown): string | null {
  return referenceNeeded(method) && !normalizeReference(reference) ? REFERENCE_NEEDED_MESSAGE : null;
}

/**
 * The same schema, with the reference required unless `methodKey` says cash — for a route's validation, leaving the
 * plain object schema for the forms that extend it.
 */
export function withReference<T extends z.ZodTypeAny>(schema: T, methodKey: string) {
  return schema.superRefine((v: Record<string, unknown>, ctx) => {
    const problem = referenceProblem(v?.[methodKey] as string | undefined, v?.reference);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reference"], message: problem });
  });
}
