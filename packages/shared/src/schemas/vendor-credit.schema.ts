import { z } from "zod";
import { billLineSchema } from "./bill.schema";

export const vendorCreditStatusSchema = z.enum(["draft", "issued", "applied", "voided"]);
export type VendorCreditStatus = z.infer<typeof vendorCreditStatusSchema>;

export const createVendorCreditSchema = z.object({
  vendorId: z.string().min(1, "Vendor is required"),
  sourceBillId: z.string().optional(),
  reason: z.string().min(1, "Reason is required"),
  issueDate: z.string().min(1, "Issue date required"),
  currency: z.string().min(3).max(3).optional(),
  lineItems: z.array(billLineSchema).min(1, "At least one line item required"),
  notes: z.string().optional().default(""),
});
export type CreateVendorCreditInput = z.infer<typeof createVendorCreditSchema>;

export const applyVendorCreditSchema = z.object({
  targetBillId: z.string().min(1, "Target bill is required"),
  amountMinor: z.number().positive("Amount must be positive"),
});
export type ApplyVendorCreditInput = z.infer<typeof applyVendorCreditSchema>;

export const vendorCreditSchema = z.object({
  id: z.string(),
  creditNumber: z.string(),
  vendorId: z.string(),
  vendorName: z.string(),
  sourceBillId: z.string().optional(),
  sourceBillNumber: z.string().optional(),
  reason: z.string(),
  issueDate: z.string(),
  status: vendorCreditStatusSchema,
  currency: z.string(),
  lineItems: z.array(billLineSchema.extend({ lineTotalMinor: z.number() })),
  subtotalMinor: z.number(),
  taxTotalMinor: z.number(),
  totalMinor: z.number(),
  amountAppliedMinor: z.number(),
  notes: z.string(),
  issuedAt: z.string().optional(),
  createdAt: z.string(),
});
export type VendorCredit = z.infer<typeof vendorCreditSchema>;
