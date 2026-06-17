import { z } from "zod";

export const CREDIT_NOTE_STATUSES = ["draft", "issued", "applied", "voided"] as const;
export type CreditNoteStatus = (typeof CREDIT_NOTE_STATUSES)[number];

const creditLineInputSchema = z.object({
  description: z.string().min(1).max(300),
  quantity: z.coerce.number().positive(),
  unitPriceMinor: z.coerce.number().int().min(0),
  discountPct: z.coerce.number().min(0).max(100).optional().default(0),
  taxPct: z.coerce.number().min(0).max(100).optional().default(0),
});

export const createCreditNoteSchema = z.object({
  invoiceId: z.string().min(1, "Invoice is required"),
  reason: z.string().min(1, "Reason is required").max(500),
  lineItems: z.array(creditLineInputSchema).min(1, "Add at least one line"),
});
export type CreateCreditNoteInput = z.infer<typeof createCreditNoteSchema>;

export const applyCreditNoteSchema = z.object({
  targetInvoiceId: z.string().optional(),
});
export type ApplyCreditNoteInput = z.infer<typeof applyCreditNoteSchema>;

const creditLineSchema = z.object({
  description: z.string(),
  quantity: z.number(),
  unitPriceMinor: z.number(),
  discountPct: z.number(),
  taxPct: z.number(),
  lineTotalMinor: z.number(),
});

export const creditNoteSchema = z.object({
  id: z.string(),
  creditNoteNumber: z.string(),
  invoiceId: z.string(),
  invoiceNumber: z.string(),
  customerId: z.string(),
  customerName: z.string(),
  reason: z.string(),
  status: z.enum(CREDIT_NOTE_STATUSES),
  lineItems: z.array(creditLineSchema),
  subtotalMinor: z.number(),
  taxTotalMinor: z.number(),
  totalMinor: z.number(),
  amountAppliedMinor: z.number(),
  currency: z.string(),
  issuedAt: z.string().optional(),
  createdAt: z.string(),
});
export type CreditNote = z.infer<typeof creditNoteSchema>;
