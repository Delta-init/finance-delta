import { z } from "zod";
import { emiDetailInputSchema, emiDetailSchema } from "./emi.schema";

export const billStatusSchema = z.enum([
  "draft",
  "pending_approval",
  "approved",
  "partially_paid",
  "paid",
  "overdue",
  "voided",
]);
export type BillStatus = z.infer<typeof billStatusSchema>;

export const billPaymentMethodSchema = z.enum([
  "bank_transfer",
  "cash",
  "cheque",
  "card",
  "online",
  "easebuzz_emi",
]);
export type BillPaymentMethod = z.infer<typeof billPaymentMethodSchema>;

/** A file attached to a bill (stored in R2). */
export const billAttachmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  mimeType: z.string(),
  size: z.number(),
  uploadedAt: z.string(),
});
export type BillAttachment = z.infer<typeof billAttachmentSchema>;

/** Update just the free-text notes on a bill (allowed on any non-voided bill). */
export const updateBillNotesSchema = z.object({
  notes: z.string().max(5000).optional().default(""),
});
export type UpdateBillNotesInput = z.infer<typeof updateBillNotesSchema>;

export const billLineSchema = z.object({
  description: z.string().min(1, "Description required"),
  quantity: z.number().positive(),
  unitPriceMinor: z.number().min(0),
  discountPct: z.number().min(0).max(100).default(0),
  taxPct: z.number().min(0).max(100).default(0),
});
export type BillLineInput = z.infer<typeof billLineSchema>;

export const createBillSchema = z.object({
  vendorId: z.string().min(1, "Vendor is required"),
  sourcePOId: z.string().optional(),
  billDate: z.string().min(1, "Bill date required"),
  dueDate: z.string().min(1, "Due date required"),
  currency: z.string().min(3).max(3).optional(),
  lineItems: z.array(billLineSchema).min(1, "At least one line item required"),
  notes: z.string().optional().default(""),
  paymentTerms: z.string().optional().default(""),
  requiresApproval: z.boolean().optional().default(false),
});
export type CreateBillInput = z.infer<typeof createBillSchema>;

export const updateBillSchema = createBillSchema.partial();
export type UpdateBillInput = z.infer<typeof updateBillSchema>;

export const recordBillPaymentSchema = z.object({
  method: billPaymentMethodSchema,
  amountMinor: z.number().positive("Amount must be positive"),
  paidOn: z.string().min(1, "Payment date required"),
  reference: z.string().optional().default(""),
  accountName: z.string().optional().default(""),
  notes: z.string().optional().default(""),
  /** Easebuzz EMI details — sent only when method is "easebuzz_emi". */
  emi: emiDetailInputSchema.optional(),
});
export type RecordBillPaymentInput = z.infer<typeof recordBillPaymentSchema>;

export const billSchema = z.object({
  id: z.string(),
  billNumber: z.string(),
  vendorId: z.string(),
  vendorName: z.string(),
  sourcePOId: z.string().optional(),
  sourcePONumber: z.string().optional(),
  billDate: z.string(),
  dueDate: z.string(),
  status: billStatusSchema,
  approvalStatus: z.enum(["not_required", "pending", "approved", "rejected"]),
  currency: z.string(),
  lineItems: z.array(billLineSchema.extend({ lineTotalMinor: z.number() })),
  subtotalMinor: z.number(),
  taxTotalMinor: z.number(),
  totalMinor: z.number(),
  amountPaidMinor: z.number(),
  balanceMinor: z.number(),
  payments: z.array(
    z.object({
      id: z.string(),
      method: billPaymentMethodSchema,
      amountMinor: z.number(),
      paidOn: z.string(),
      reference: z.string(),
      accountName: z.string(),
      notes: z.string(),
      emi: emiDetailSchema.optional(),
      createdAt: z.string(),
    }),
  ),
  attachments: z.array(billAttachmentSchema).default([]),
  notes: z.string(),
  paymentTerms: z.string(),
  createdAt: z.string(),
});
export type Bill = z.infer<typeof billSchema>;
