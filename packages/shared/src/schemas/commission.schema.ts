import { z } from "zod";

// ── Commission structure ───────────────────────────────────────────────────────

export const commissionTierSchema = z.object({
  /** Upper bound of this tier in AED minor units. null = no limit (top tier). */
  upToMinor: z.number().nullable(),
  /** Percentage rate for this tier (0–100). */
  percentage: z.number().min(0).max(100),
});
export type CommissionTier = z.infer<typeof commissionTierSchema>;

export const createCommissionStructureSchema = z.object({
  salespersonId: z.string().min(1),
  type: z.enum(["flat", "percentage", "tiered"]),
  flatAmountMinor: z.number().int().min(0).optional(),
  percentage: z.number().min(0).max(100).optional(),
  tiers: z.array(commissionTierSchema).optional(),
  basis: z.enum(["invoice_raised", "payment_received"]),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  effectiveTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  notes: z.string().default(""),
});
export type CreateCommissionStructureInput = z.infer<typeof createCommissionStructureSchema>;

export const updateCommissionStructureSchema = createCommissionStructureSchema.partial().extend({
  isActive: z.boolean().optional(),
});
export type UpdateCommissionStructureInput = z.infer<typeof updateCommissionStructureSchema>;

export interface CommissionStructure {
  id: string;
  salespersonId: string;
  salespersonName: string;
  type: "flat" | "percentage" | "tiered";
  flatAmountMinor?: number;
  percentage?: number;
  tiers?: CommissionTier[];
  basis: "invoice_raised" | "payment_received";
  isLocked: boolean;
  isActive: boolean;
  effectiveFrom: string;
  effectiveTo?: string;
  notes: string;
  lockedByName?: string;
  lockedAt?: string;
  createdAt: string;
}

// ── Commission record ─────────────────────────────────────────────────────────

export interface CommissionRecord {
  id: string;
  structureId: string;
  salespersonId: string;
  salespersonName: string;
  invoiceId: string;
  invoiceNumber: string;
  invoiceTotalMinor: number;
  commissionMinor: number;
  basis: "invoice_raised" | "payment_received";
  status: "earned" | "paid" | "cancelled";
  calculatedAt: string;
  paidAt?: string;
  paidExpenseId?: string;
  notes: string;
}

export const markCommissionPaidSchema = z.object({
  recordIds: z.array(z.string()).min(1),
  expenseId: z.string().optional(),
  paidAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  notes: z.string().default(""),
});
export type MarkCommissionPaidInput = z.infer<typeof markCommissionPaidSchema>;

// ── Commission report ─────────────────────────────────────────────────────────

export interface CommissionReportRow {
  salespersonId: string;
  salespersonName: string;
  earnedMinor: number;
  paidMinor: number;
  pendingMinor: number;
  invoiceCount: number;
}

export interface CommissionReport {
  from: string;
  to: string;
  currency: string;
  rows: CommissionReportRow[];
  totals: { earnedMinor: number; paidMinor: number; pendingMinor: number };
}

// ── Query schemas ─────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const commissionRecordQuerySchema = z.object({
  salespersonId: z.string().optional(),
  status: z.enum(["earned", "paid", "cancelled"]).optional(),
  from: z.string().regex(DATE_RE, "Must be YYYY-MM-DD").optional(),
  to: z.string().regex(DATE_RE, "Must be YYYY-MM-DD").optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type CommissionRecordQuery = z.infer<typeof commissionRecordQuerySchema>;
