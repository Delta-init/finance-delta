import { z } from "zod";
import { tagRefSchema } from "./tag.schema";
import { taxInputSchema } from "./invoice.schema";

export const QUOTE_STATUSES = [
  "draft",
  "sent",
  "accepted",
  "declined",
  "expired",
] as const;
export const quoteStatusSchema = z.enum(QUOTE_STATUSES);
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

/** Line item as submitted by the client (totals are computed server-side).
 *  `taxes` (multi-tax, e.g. CGST + SGST) takes precedence; `taxPct` is the
 *  legacy single-rate field kept for backward compatibility. */
export const lineItemInputSchema = z.object({
  description: z.string().min(1, "Description is required").max(300),
  quantity: z.coerce.number().positive("Qty must be > 0"),
  unitPriceMinor: z.coerce.number().int().min(0),
  discountPct: z.coerce.number().min(0).max(100).optional().default(0),
  taxPct: z.coerce.number().min(0).max(100).optional().default(0),
  taxes: z.array(taxInputSchema).optional().default([]),
  itemId: z.string().optional(),
});
export type LineItemInput = z.infer<typeof lineItemInputSchema>;

export const createQuotationSchema = z.object({
  customerId: z.string().min(1, "Select a customer"),
  issueDate: z.string().min(1, "Issue date is required"),
  expiryDate: z.string().min(1, "Expiry date is required"),
  currency: z.string().min(3).max(3).optional(),
  notes: z.string().max(2000).optional().default(""),
  terms: z.string().max(2000).optional().default(""),
  tagIds: z.array(z.string()).optional().default([]),
  lineItems: z.array(lineItemInputSchema).min(1, "Add at least one line item"),
  taxInclusive: z.boolean().optional().default(false),
});
export type CreateQuotationInput = z.infer<typeof createQuotationSchema>;

export const updateQuotationSchema = createQuotationSchema.partial();
export type UpdateQuotationInput = z.infer<typeof updateQuotationSchema>;

/** Convert payload — partial conversion via per-line quantity overrides (by index). */
export const convertQuotationSchema = z.object({
  target: z.enum(["salesOrder"]),
  lines: z
    .array(z.object({ index: z.number().int().min(0), quantity: z.coerce.number().positive() }))
    .optional(),
});
export type ConvertQuotationInput = z.infer<typeof convertQuotationSchema>;

/** Convert-to-invoice payload — supports partial / progressive invoicing.
 *  - full: invoice the entire remaining balance of the quote
 *  - percentage: invoice a % of the quote total
 *  - amount: invoice a fixed amount (minor units, quote currency)
 *  - per_line: invoice a custom ex-tax amount per line (by index) */
export const convertToInvoiceSchema = z.object({
  mode: z.enum(["full", "percentage", "amount", "per_line"]).default("full"),
  percentage: z.coerce.number().min(0).max(100).optional(),
  amountMinor: z.coerce.number().int().min(0).optional(),
  lineAmountsMinor: z.array(z.coerce.number().int().min(0)).optional(),
});
export type ConvertToInvoiceInput = z.infer<typeof convertToInvoiceSchema>;

// ── Output DTOs ──
export const lineItemSchema = lineItemInputSchema.extend({
  discountPct: z.number(),
  taxPct: z.number(),
  taxes: z.array(taxInputSchema).default([]),
  lineSubtotalMinor: z.number(),
  discountMinor: z.number(),
  taxMinor: z.number(),
  lineTotalMinor: z.number(),
});
export type LineItem = z.infer<typeof lineItemSchema>;

export const taxBreakdownItemSchema = z.object({
  code: z.string(),
  amountMinor: z.number(),
});
export type TaxBreakdownItem = z.infer<typeof taxBreakdownItemSchema>;

export const quotationSchema = z.object({
  id: z.string(),
  quoteNumber: z.string(),
  customerId: z.string(),
  customerName: z.string(),
  status: quoteStatusSchema,
  issueDate: z.string(),
  expiryDate: z.string(),
  currency: z.string(),
  lineItems: z.array(lineItemSchema),
  subtotalMinor: z.number(),
  discountTotalMinor: z.number(),
  taxTotalMinor: z.number(),
  taxBreakdown: z.array(taxBreakdownItemSchema).default([]),
  totalMinor: z.number(),
  taxInclusive: z.boolean().default(false),
  /** Cumulative invoiced amount (sum of created invoices' totals), quote currency. */
  invoicedMinor: z.number().default(0),
  notes: z.string(),
  terms: z.string(),
  tags: z.array(tagRefSchema).default([]),
  convertedTo: z
    .object({
      salesOrderId: z.string().optional(),
      invoiceId: z.string().optional(),
      invoiceIds: z.array(z.string()).default([]),
    })
    .optional(),
  createdAt: z.string(),
});
export type Quotation = z.infer<typeof quotationSchema>;
