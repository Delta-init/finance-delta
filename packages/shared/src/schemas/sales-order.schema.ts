import { z } from "zod";
import { lineItemSchema } from "./quotation.schema";
import { tagRefSchema } from "./tag.schema";

export const SALES_ORDER_STATUSES = ["open", "fulfilled", "cancelled"] as const;
export const salesOrderStatusSchema = z.enum(SALES_ORDER_STATUSES);
export type SalesOrderStatus = (typeof SALES_ORDER_STATUSES)[number];

export const salesOrderSchema = z.object({
  id: z.string(),
  orderNumber: z.string(),
  customerId: z.string(),
  customerName: z.string(),
  sourceQuoteId: z.string().optional(),
  sourceQuoteNumber: z.string().optional(),
  status: salesOrderStatusSchema,
  currency: z.string(),
  lineItems: z.array(lineItemSchema),
  subtotalMinor: z.number(),
  discountTotalMinor: z.number(),
  taxTotalMinor: z.number(),
  totalMinor: z.number(),
  tags: z.array(tagRefSchema).default([]),
  createdAt: z.string(),
});
export type SalesOrder = z.infer<typeof salesOrderSchema>;
