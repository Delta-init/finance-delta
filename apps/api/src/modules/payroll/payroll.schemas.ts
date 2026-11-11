import { z } from "zod";
import { manualPayrollLineSchema } from "@delta/shared";

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

export const payRunSchema = z
  .object({
    // Empty or absent means everybody still owed. Held lines are never included
    // either way — the service excludes them.
    lineIds: z.array(objectId).max(2000).optional(),
    // How much each named person gets in this payment, in place of `lineIds` (the user, 2026-11-03: one person paid
    // part by bank transfer, part in cash). Without it a named person is paid all they are still owed.
    amounts: z
      .array(z.object({ lineId: objectId, amountMinor: z.number().int().positive() }))
      .min(1)
      .max(2000)
      .optional(),
    bankAccountId: objectId,
    method: z.enum(["bank_transfer", "cash", "cheque", "card", "online"]),
    paidOn: z.string().min(1),
    reference: z.string().trim().max(120).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.amounts && v.lineIds?.length) {
      ctx.addIssue({ code: "custom", path: ["amounts"], message: "Send lineIds or amounts, not both" });
    }
    if (v.amounts && new Set(v.amounts.map((a) => a.lineId)).size !== v.amounts.length) {
      ctx.addIssue({ code: "custom", path: ["amounts"], message: "A person can be named once in a payment" });
    }
  });

export const holdLineSchema = z.object({
  hold: z.boolean(),
  reason: z.string().trim().max(200).optional(),
});

export const returnRunSchema = z.object({
  reason: z.string().trim().min(1, "Tell HR what needs fixing").max(300),
});

export const reversePaymentSchema = z.object({
  // Required: a payment that came back with no explanation is one nobody can
  // account for later.
  reason: z.string().trim().min(1, "Say why the payment is being reversed").max(300),
});

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const peopleReportQuerySchema = z.object({
  from: isoDate,
  to: isoDate,
  departmentId: objectId.optional(),
  search: z.string().trim().max(120).optional(),
});

export const personDetailQuerySchema = z.object({ from: isoDate, to: isoDate });
/** A person's ledger (2026-11-05): paged, filtered and searched by the server; no dates means all of it. */
export const personLedgerQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  kind: z.enum(["invoice", "payroll", "expense", "advance", "one_time"]).optional(),
  q: z.string().trim().max(120).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  sort: z.enum(["asc", "desc"]).default("desc"),
});

// ── Manual payroll (2026-11-11): an organization not run through HRMS enters its months here ──────────────────────

export const createManualRunSchema = z.object({
  period,
  /** The month's currency; the organization's own when left out. */
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/, "Use a 3-letter currency code").optional(),
  notes: z.string().trim().max(300).optional(),
  /** An import's rows, the good ones added at once (manual.service createManualRun). */
  lines: z.array(manualPayrollLineSchema).max(1000).optional(),
});

/** People onto an open month: one typed (refused whole if wrong), or an import's rows with `partial` (good ones added). */
export const addManualLinesSchema = z.object({
  lines: z.array(manualPayrollLineSchema).min(1).max(1000),
  partial: z.boolean().optional(),
});

export const updateManualLineSchema = manualPayrollLineSchema;
