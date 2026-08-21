import { z } from "zod";
import { tagRefSchema } from "./tag.schema";
import { emiDetailInputSchema, emiDetailSchema } from "./emi.schema";

export const TAX_CODES = ["VAT", "GST", "CGST", "SGST", "IGST", "TDS", "WHT", "NONE"] as const;
export type TaxCode = (typeof TAX_CODES)[number];

export const PAYMENT_METHODS = [
  "cash",
  "bank_transfer",
  "cheque",
  "card",
  "easebuzz_emi",
  "other",
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const INVOICE_STATUSES = [
  "draft",
  "sent",
  "viewed",
  "paid",
  "partial",
  "overdue",
  "void",
] as const;
export const invoiceStatusSchema = z.enum(INVOICE_STATUSES);
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const RECURRING_FREQUENCIES = ["weekly", "monthly", "annually"] as const;
export type RecurringFrequency = (typeof RECURRING_FREQUENCIES)[number];

// ── Input schemas ──

export const taxInputSchema = z.object({
  code: z.string().min(1).max(20),
  rate: z.coerce.number().min(0).max(100),
});
export type TaxInput = z.infer<typeof taxInputSchema>;

export const invoiceLineInputSchema = z.object({
  description: z.string().min(1, "Description required").max(300),
  quantity: z.coerce.number().positive("Qty must be > 0"),
  unitPriceMinor: z.coerce.number().int().min(0),
  discountPct: z.coerce.number().min(0).max(100).optional().default(0),
  taxes: z.array(taxInputSchema).optional().default([]),
  itemId: z.string().optional(),
  warehouseId: z.string().optional(),
});
export type InvoiceLineInput = z.infer<typeof invoiceLineInputSchema>;

export const progressInputSchema = z.object({
  contractDescription: z.string().min(1).max(500),
  contractValueMinor: z.coerce.number().int().min(0),
  stageName: z.string().min(1).max(200),
  stageNumber: z.coerce.number().int().min(1),
  pctOfContract: z.coerce.number().min(0).max(100),
});
export type ProgressInput = z.infer<typeof progressInputSchema>;

export const recurringInputSchema = z.object({
  frequency: z.enum(RECURRING_FREQUENCIES),
  startDate: z.string().min(1, "Start date required"),
  endDate: z.string().optional(),
  isActive: z.boolean().default(true),
});
export type RecurringInput = z.infer<typeof recurringInputSchema>;

export const recordPaymentSchema = z.object({
  method: z.enum(PAYMENT_METHODS),
  amountMinor: z.coerce.number().int().positive("Amount must be positive"),
  paidOn: z.string().min(1, "Payment date is required"),
  reference: z.string().max(200).optional().default(""),
  notes: z.string().max(1000).optional().default(""),
  accountName: z.string().max(100).optional().default(""),
  /** Easebuzz EMI details — sent only when method is "easebuzz_emi". */
  emi: emiDetailInputSchema.optional(),
  /** Populated by the server after uploading to R2 — not accepted from client directly. */
  proofUrl: z.string().url().optional(),
  proofKey: z.string().optional(),
});
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;

export const PRINT_LOCALES = ["en", "ar", "fr"] as const;
export type PrintLocale = (typeof PRINT_LOCALES)[number];

export const createInvoiceSchema = z.object({
  customerId: z.string().min(1, "Select a customer"),
  salespersonId: z.string().min(1, "Salesperson is required"),
  reference: z.string().max(200).optional().default(""),
  issueDate: z.string().min(1, "Issue date is required"),
  dueDate: z.string().min(1, "Due date is required"),
  currency: z.string().min(3).max(3).optional(),
  notes: z.string().max(2000).optional().default(""),
  terms: z.string().max(2000).optional().default(""),
  tagIds: z.array(z.string()).optional().default([]),
  lineItems: z.array(invoiceLineInputSchema).min(1, "Add at least one line item"),
  progress: progressInputSchema.nullable().optional(),
  recurring: recurringInputSchema.nullable().optional(),
  locale: z.enum(PRINT_LOCALES).optional().default("en"),
  exchangeRate: z.coerce.number().positive().optional(),
  taxInclusive: z.boolean().optional().default(false),
});
export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;

export const updateInvoiceSchema = createInvoiceSchema.partial();
export type UpdateInvoiceInput = z.infer<typeof updateInvoiceSchema>;

// ── Output DTOs ──

export const taxBreakdownSchema = z.object({
  code: z.string(),
  rate: z.number(),
  amountMinor: z.number(),
});
export type TaxBreakdown = z.infer<typeof taxBreakdownSchema>;

export const paymentSchema = z.object({
  id: z.string(),
  method: z.enum(PAYMENT_METHODS),
  amountMinor: z.number(),
  paidOn: z.string(),
  reference: z.string(),
  notes: z.string(),
  accountName: z.string(),
  emi: emiDetailSchema.optional(),
  proofUrl: z.string().optional(),
  createdAt: z.string(),
});
export type Payment = z.infer<typeof paymentSchema>;

export const invoiceLineSchema = z.object({
  description: z.string(),
  quantity: z.number(),
  unitPriceMinor: z.number(),
  discountPct: z.number(),
  itemId: z.string().optional(),
  warehouseId: z.string().optional(),
  taxes: z.array(taxBreakdownSchema),
  lineSubtotalMinor: z.number(),
  discountMinor: z.number(),
  taxableMinor: z.number(),
  taxTotalMinor: z.number(),
  lineTotalMinor: z.number(),
});
export type InvoiceLine = z.infer<typeof invoiceLineSchema>;

export const invoiceSchema = z.object({
  id: z.string(),
  invoiceNumber: z.string(),
  customerId: z.string(),
  customerName: z.string(),
  salespersonId: z.string(),
  salespersonName: z.string(),
  reference: z.string(),
  status: invoiceStatusSchema,
  issueDate: z.string(),
  dueDate: z.string(),
  currency: z.string(),
  lineItems: z.array(invoiceLineSchema),
  subtotalMinor: z.number(),
  discountTotalMinor: z.number(),
  taxBreakdown: z.array(z.object({ code: z.string(), amountMinor: z.number() })),
  taxTotalMinor: z.number(),
  totalMinor: z.number(),
  amountPaidMinor: z.number(),
  balanceMinor: z.number(),
  notes: z.string(),
  terms: z.string(),
  tags: z.array(tagRefSchema).default([]),
  branding: z
    .object({
      logoUrl: z.string().optional(),
      primaryColor: z.string().optional(),
      footerText: z.string().optional(),
    })
    .optional(),
  progress: z
    .object({
      contractDescription: z.string(),
      contractValueMinor: z.number(),
      stageName: z.string(),
      stageNumber: z.number(),
      pctOfContract: z.number(),
    })
    .nullable()
    .optional(),
  recurring: z
    .object({
      frequency: z.enum(RECURRING_FREQUENCIES),
      startDate: z.string(),
      endDate: z.string().optional(),
      nextRunAt: z.string(),
      isActive: z.boolean(),
    })
    .nullable()
    .optional(),
  payments: z.array(paymentSchema).default([]),
  sourceQuoteId: z.string().optional(),
  locale: z.string().optional(),
  exchangeRate: z.number().optional(),
  taxInclusive: z.boolean().default(false),
  createdAt: z.string(),
});
export type Invoice = z.infer<typeof invoiceSchema>;
