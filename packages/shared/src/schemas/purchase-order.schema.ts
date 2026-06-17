import { z } from "zod";

export const poStatusSchema = z.enum(["draft", "sent", "received", "billed", "cancelled"]);
export type POStatus = z.infer<typeof poStatusSchema>;

export const poLineSchema = z.object({
  description: z.string().min(1, "Description required"),
  quantity: z.number().positive("Quantity must be positive"),
  unitPriceMinor: z.number().min(0),
  discountPct: z.number().min(0).max(100).default(0),
  taxPct: z.number().min(0).max(100).default(0),
});
export type POLineInput = z.infer<typeof poLineSchema>;

export const createPOSchema = z.object({
  vendorId: z.string().min(1, "Vendor is required"),
  issueDate: z.string().min(1, "Issue date required"),
  expectedDate: z.string().optional(),
  currency: z.string().min(3).max(3).optional(),
  lineItems: z.array(poLineSchema).min(1, "At least one line item required"),
  notes: z.string().optional().default(""),
});
export type CreatePOInput = z.infer<typeof createPOSchema>;

export const updatePOSchema = createPOSchema.partial();
export type UpdatePOInput = z.infer<typeof updatePOSchema>;

export const purchaseOrderSchema = z.object({
  id: z.string(),
  poNumber: z.string(),
  vendorId: z.string(),
  vendorName: z.string(),
  issueDate: z.string(),
  expectedDate: z.string().optional(),
  status: poStatusSchema,
  currency: z.string(),
  lineItems: z.array(
    poLineSchema.extend({ lineTotalMinor: z.number() }),
  ),
  subtotalMinor: z.number(),
  taxTotalMinor: z.number(),
  totalMinor: z.number(),
  notes: z.string(),
  sourceBillId: z.string().optional(),
  createdAt: z.string(),
});
export type PurchaseOrder = z.infer<typeof purchaseOrderSchema>;
