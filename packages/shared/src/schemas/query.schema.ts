import { z } from "zod";
import { quoteStatusSchema } from "./quotation.schema";
import { salesOrderStatusSchema } from "./sales-order.schema";

const toArray = (v: string | string[] | undefined): string[] | undefined =>
  v === undefined ? undefined : Array.isArray(v) ? v : [v];

/** Query-string boolean — z.coerce.boolean() treats the string "false" as true. */
const queryBool = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
  .transform((v) => v === true || v === "true" || v === "1")
  .optional();

/** Base list query — query-string params (all strings) coerced to typed values. */
export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  sort: z.string().optional(),
  dir: z.enum(["asc", "desc"]).default("desc"),
  q: z.string().trim().optional(),
  tagIds: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform(toArray),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
}
export interface Paginated<T> {
  data: T[];
  meta: PageMeta;
}

// ── Per-resource query schemas ──
export const customerQuerySchema = listQuerySchema.extend({
  status: z.enum(["active", "archived"]).optional(),
});
export type CustomerQuery = z.infer<typeof customerQuerySchema>;

export const userQuerySchema = listQuerySchema.extend({
  status: z.enum(["active", "suspended"]).optional(),
  /**
   * Leave out accounts that exist only so a payroll employee can be named as a
   * salesperson.
   *
   * Opt-in, and used by the Users admin screen alone. Every other caller — the
   * salesperson pickers on invoices, quotations and commission structures, and
   * the mapping screen — needs those accounts and would break without them,
   * which is why this is not the default.
   */
  excludePayrollOnly: queryBool,
});
export type UserQuery = z.infer<typeof userQuerySchema>;

export const roleQuerySchema = listQuerySchema;
export type RoleQuery = z.infer<typeof roleQuerySchema>;

export const tagQuerySchema = listQuerySchema;
export type TagQuery = z.infer<typeof tagQuerySchema>;

export const departmentQuerySchema = listQuerySchema;
export type DepartmentQuery = z.infer<typeof departmentQuerySchema>;

export const quotationQuerySchema = listQuerySchema.extend({
  status: quoteStatusSchema.optional(),
  issueFrom: z.string().optional(),
  issueTo: z.string().optional(),
  expiryFrom: z.string().optional(),
  expiryTo: z.string().optional(),
});
export type QuotationQuery = z.infer<typeof quotationQuerySchema>;

export const salesOrderQuerySchema = listQuerySchema.extend({
  status: salesOrderStatusSchema.optional(),
});
export type SalesOrderQuery = z.infer<typeof salesOrderQuerySchema>;

import { invoiceStatusSchema } from "./invoice.schema";

export const invoiceQuerySchema = listQuerySchema.extend({
  status: invoiceStatusSchema.optional(),
  /** Filter by where the invoice has got to in approval, for the queue. */
  approval: z.enum(["not_required", "pending", "approved", "returned"]).optional(),
  salespersonId: z.string().optional(),
  issueFrom: z.string().optional(),
  issueTo: z.string().optional(),
  dueFrom: z.string().optional(),
  dueTo: z.string().optional(),
});
export type InvoiceQuery = z.infer<typeof invoiceQuerySchema>;

export const vendorQuerySchema = listQuerySchema.extend({
  status: z.enum(["active", "archived"]).optional(),
});
export type VendorQuery = z.infer<typeof vendorQuerySchema>;

export const poQuerySchema = listQuerySchema.extend({
  status: z.enum(["draft", "sent", "received", "billed", "cancelled"]).optional(),
  vendorId: z.string().optional(),
});
export type POQuery = z.infer<typeof poQuerySchema>;

export const billQuerySchema = listQuerySchema.extend({
  status: z.enum(["draft", "pending_approval", "approved", "partially_paid", "paid", "overdue", "voided"]).optional(),
  vendorId: z.string().optional(),
  overdue: queryBool,
  dueFrom: z.string().optional(),
  dueTo: z.string().optional(),
});
export type BillQuery = z.infer<typeof billQuerySchema>;

export const vendorCreditQuerySchema = listQuerySchema.extend({
  status: z.enum(["draft", "issued", "applied", "voided"]).optional(),
  vendorId: z.string().optional(),
});
export type VendorCreditQuery = z.infer<typeof vendorCreditQuerySchema>;

import { expenseCategorySchema, expenseStatusSchema } from "./expense.schema";

export const expenseQuerySchema = listQuerySchema.extend({
  status: expenseStatusSchema.optional(),
  category: expenseCategorySchema.optional(),
  submittedById: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  projectName: z.string().optional(),
  costCentre: z.string().optional(),
  isRecurring: queryBool,
});
export type ExpenseQuery = z.infer<typeof expenseQuerySchema>;

import { bankAccountTypeSchema, bankTransactionStatusSchema } from "./banking.schema";

export const bankAccountQuerySchema = listQuerySchema.extend({
  accountType: bankAccountTypeSchema.optional(),
  isActive: queryBool,
  currency: z.string().optional(),
});
export type BankAccountQuery = z.infer<typeof bankAccountQuerySchema>;

export const bankTransactionQuerySchema = listQuerySchema.extend({
  status: bankTransactionStatusSchema.optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  isReconciled: queryBool,
  source: z.enum(["manual", "import"]).optional(),
});
export type BankTransactionQuery = z.infer<typeof bankTransactionQuerySchema>;

import { itemTypeSchema, movementTypeSchema } from "./inventory.schema";

export const itemQuerySchema = listQuerySchema.extend({
  type: itemTypeSchema.optional(),
  trackStock: queryBool,
  isActive: queryBool,
  lowStock: queryBool,
  warehouseId: z.string().optional(),
});
export type ItemQuery = z.infer<typeof itemQuerySchema>;

export const warehouseQuerySchema = listQuerySchema.extend({
  isActive: queryBool,
});
export type WarehouseQuery = z.infer<typeof warehouseQuerySchema>;

export const priceListQuerySchema = listQuerySchema;
export type PriceListQuery = z.infer<typeof priceListQuerySchema>;

export const stockMovementQuerySchema = listQuerySchema.extend({
  movementType: movementTypeSchema.optional(),
  warehouseId: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
});
export type StockMovementQuery = z.infer<typeof stockMovementQuerySchema>;
