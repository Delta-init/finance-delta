import { z } from "zod";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateStr = z.string().regex(DATE_RE, "Must be YYYY-MM-DD");

// ── Loan ──────────────────────────────────────────────────────────────────────

export const createLoanSchema = z.object({
  type: z.enum(["taken", "given"]),
  counterpartyName: z.string().min(1),
  counterpartyType: z.enum(["customer", "vendor", "other"]).default("other"),
  counterpartyId: z.string().optional(),
  principalMinor: z.number().int().min(1),
  interestRate: z.number().min(0).max(100),
  interestType: z.enum(["simple", "compound"]).default("simple"),
  startDate: dateStr,
  dueDate: dateStr.optional(),
  repaymentFrequency: z
    .enum(["monthly", "quarterly", "annually", "bullet", "none"])
    .default("monthly"),
  notes: z.string().default(""),
});
export type CreateLoanInput = z.infer<typeof createLoanSchema>;

export const updateLoanSchema = z.object({
  status: z.enum(["active", "closed", "defaulted"]).optional(),
  dueDate: dateStr.optional(),
  notes: z.string().optional(),
});
export type UpdateLoanInput = z.infer<typeof updateLoanSchema>;

export const loanQuerySchema = z.object({
  type: z.enum(["taken", "given"]).optional(),
  status: z.enum(["active", "closed", "defaulted"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type LoanQuery = z.infer<typeof loanQuerySchema>;

// ── Repayment ─────────────────────────────────────────────────────────────────

export const recordRepaymentSchema = z.object({
  paidOn: dateStr,
  principalMinor: z.number().int().min(0),
  interestMinor: z.number().int().min(0),
  notes: z.string().default(""),
});
export type RecordRepaymentInput = z.infer<typeof recordRepaymentSchema>;

// ── DTO types ─────────────────────────────────────────────────────────────────

export interface LoanRepayment {
  id: string;
  loanId: string;
  paidOn: string;
  principalMinor: number;
  interestMinor: number;
  totalMinor: number;
  notes: string;
  createdAt: string;
}

export interface Loan {
  id: string;
  loanNumber: string;
  type: "taken" | "given";
  counterpartyName: string;
  counterpartyType: "customer" | "vendor" | "other";
  counterpartyId?: string;
  principalMinor: number;
  interestRate: number;
  interestType: "simple" | "compound";
  startDate: string;
  dueDate?: string;
  repaymentFrequency: "monthly" | "quarterly" | "annually" | "bullet" | "none";
  status: "active" | "closed" | "defaulted";
  notes: string;
  // computed
  totalRepaidPrincipalMinor: number;
  totalRepaidInterestMinor: number;
  outstandingPrincipalMinor: number;
  accruedInterestMinor: number;
  netOwedMinor: number;
  createdAt: string;
}

export interface LoanSummaryReport {
  asOf: string;
  taken: {
    count: number;
    principalMinor: number;
    outstandingMinor: number;
    interestAccruedMinor: number;
  };
  given: {
    count: number;
    principalMinor: number;
    outstandingMinor: number;
    interestAccruedMinor: number;
  };
  byStatus: { status: string; count: number; outstandingMinor: number }[];
  loans: Loan[];
}
