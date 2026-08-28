import { z } from "zod";

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, "Must be a valid id");
const period = z.string().regex(/^\d{4}-\d{2}$/, "Period must be YYYY-MM");

export const importPreviewQuerySchema = z.object({ hrmsOrgId: objectId, period });
export const importRunSchema = z.object({ hrmsOrgId: objectId, period });

export const runQuerySchema = z.object({
  period: period.optional(),
  status: z.enum(["imported", "additions", "approved", "partially_paid", "paid", "returned", "voided"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const addAdjustmentsSchema = z.object({
  items: z
    .array(
      z.object({
        lineId: objectId,
        kind: z.enum(["addition", "deduction"]),
        label: z.string().trim().min(1).max(80),
        // Minor units, so this is an integer by definition. A float here would
        // mean somebody is still thinking in decimals somewhere upstream.
        amountMinor: z.number().int().positive(),
        notes: z.string().trim().max(300).optional(),
      }),
    )
    .min(1)
    .max(200),
});

export const payRunSchema = z.object({
  // Empty or absent means everybody still owed. Held lines are never included
  // either way — the service excludes them.
  lineIds: z.array(objectId).max(2000).optional(),
  bankAccountId: objectId,
  method: z.enum(["bank_transfer", "cash", "cheque", "card", "online"]),
  paidOn: z.string().min(1),
  reference: z.string().trim().max(120).optional(),
});

export const returnRunSchema = z.object({
  reason: z.string().trim().min(1, "Tell HR what needs fixing").max(300),
});

export const reversePaymentSchema = z.object({
  // Required: a payment that came back with no explanation is one nobody can
  // account for later.
  reason: z.string().trim().min(1, "Say why the payment is being reversed").max(300),
});
