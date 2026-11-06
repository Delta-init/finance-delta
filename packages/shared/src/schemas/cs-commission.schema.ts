import { z } from "zod";
import { expensePaymentMethodSchema } from "./expense.schema";

/*
 * The CS Portal's commission in finance (the user, 2026-11-03: "CS commission in finance, beside the CRM commission,
 * in AED"). The CS Portal credits each CS's commission (in USD) for the bonuses and deposits they bring, up their Up
 * Head chain; each CS's credits are approved per period — bonus monthly (YYYY-MM), deposit quarterly (YYYY-Qn) — by
 * the broker admin, then the academic head, there, and then by finance here: the Finance step that used to be the CS
 * Portal's own. Finance reads a period live from the CS Portal and pays it:
 *
 *   waiting   still with the broker admin or academic head in the CS Portal
 *   ready     with finance — a manager may approve (also one a CS Portal Super Admin released there)
 *   approved  a manager approved it here, which released the credits in the CS Portal — its amount frozen
 *   paid      accounts recorded the payment with its receipt (a paid expense), or a payroll run paid it
 *   rejected  rejected in the CS Portal
 *
 * Shown in the CS's own currency: AED at the CS Portal's fixed 1 USD = 3.67 AED, INR (1 INR = 0.010 USD) for a
 * Bangalore team's CS — paid by an organization in that currency. One payout per kind, period and CS across all of
 * finance: it can never be paid twice.
 */

export const CS_COMMISSION_KINDS = ["bonus", "deposit"] as const;
export type CsCommissionKind = (typeof CS_COMMISSION_KINDS)[number];
export const CS_COMMISSION_PERIOD: Record<CsCommissionKind, RegExp> = {
  bonus: /^\d{4}-(0[1-9]|1[0-2])$/,
  deposit: /^\d{4}-Q[1-4]$/,
};
/** The CS Portal's fixed rates (components/utils/displayCurrency.js there). */
export const CS_AED_PER_USD = 3.67;
export const CS_INR_PER_USD = 100;

const who = {
  kind: z.enum(CS_COMMISSION_KINDS),
  period: z.string().trim().max(10),
  recipientId: z.string().trim().min(1).max(64),
};
const periodFits = (v: { kind: CsCommissionKind; period: string }, ctx: z.RefinementCtx) => {
  if (!CS_COMMISSION_PERIOD[v.kind].test(v.period)) {
    ctx.addIssue({ code: "custom", path: ["period"], message: v.kind === "bonus" ? "period is YYYY-MM" : "period is YYYY-Qn" });
  }
};

export const approveCsCommissionSchema = z.object({ ...who, note: z.string().trim().max(500).optional().default("") }).superRefine(periodFits);
export type ApproveCsCommissionInput = z.infer<typeof approveCsCommissionSchema>;

export const revokeCsCommissionSchema = z.object(who).superRefine(periodFits);
export type RevokeCsCommissionInput = z.infer<typeof revokeCsCommissionSchema>;

const payFields = {
  ...who,
  /** The day the money went. */
  paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the date it was paid"),
  paymentMethod: expensePaymentMethodSchema,
  reference: z.string().trim().max(120).optional().default(""),
  category: z.string().trim().min(1, "Choose an expense category"),
  subcategory: z.string().trim().max(60).optional(),
  departmentId: z.union([z.literal(""), z.string().regex(/^[a-f\d]{24}$/i, "Invalid department")]).optional().default(""),
  /** The receipt, uploaded first (POST /commissions/cs/uploads) — required. */
  receipt: z.object({
    name: z.string().trim().min(1).max(200),
    key: z.string().min(1).max(400),
    size: z.number().int().min(0).optional(),
    mimeType: z.string().max(100).optional(),
  }, { message: "Attach the receipt" }),
};
export const payCsCommissionSchema = z.object(payFields).superRefine(periodFits);
export type PayCsCommissionInput = z.infer<typeof payCsCommissionSchema>;

/**
 * Record payment (the user, 2026-11-06): a manager approves and pays a CS's period in one step — while it still waits
 * for the CS Portal's broker admin or academic head too, then only with a reason, which goes on the release there.
 */
export const recordCsCommissionPaymentSchema = z.object({
  ...payFields,
  reason: z.string().trim().max(300).optional().default(""),
}).superRefine(periodFits);
export type RecordCsCommissionPaymentInput = z.infer<typeof recordCsCommissionPaymentSchema>;

export type CsCommissionState = "waiting" | "ready" | "approved" | "paid" | "rejected";

export interface CsCommissionCredit {
  id: string;
  date: string;
  student: string;
  /** bonus_with / bonus_without / deposit. */
  method: string;
  level: number;
  position: string;
  percentage: number;
  baseUsd: number;
  amountUsd: number;
  status: string;
  txnId: string;
  initiator: string;
}

export interface CsCommissionStage { status: string; by: string; at: string | null }

export interface CsCommissionPayoutView {
  state: "approved" | "paid";
  amountMinor: number;
  currency: string;
  amountUsd: number;
  approvedByName: string;
  approvedAt: string;
  approvalNote: string;
  /** Approved and paid here before the CS Portal's broker admin and academic head; approvalNote says why (2026-11-06). */
  beforePortal?: boolean;
  paidByName?: string;
  paidOn?: string;
  paymentMethod?: string;
  reference?: string;
  expense?: { id: string; expenseNumber: string; status: string } | null;
  receipt?: { name: string; url: string } | null;
  orgId: string;
  orgName: string;
  payrollRunNumber: string;
}

export interface CsCommissionPerson {
  recipientId: string;
  name: string;
  email: string;
  location: "dubai" | "bangalore";
  /** AED, or INR for a Bangalore team. */
  currency: "AED" | "INR";
  totalUsd: number;
  /** The total in `currency`, minor units. */
  amountMinor: number;
  credits: CsCommissionCredit[];
  approval: {
    overall: string;
    broker: CsCommissionStage;
    academic: CsCommissionStage;
    finance: CsCommissionStage;
    releasedAt: string | null;
    releasedBy: string;
    byFinance: boolean;
    /** Released by finance before the broker admin and academic head, and why (2026-11-06). */
    override?: boolean;
    overrideReason?: string;
  };
  state: CsCommissionState;
  payout: CsCommissionPayoutView | null;
}

export interface CsCommissionPeriod {
  kind: CsCommissionKind;
  period: string;
  /** Approvals start only once the period has ended. */
  ended: boolean;
  people: CsCommissionPerson[];
  /** Per currency: what the period comes to, and what is approved and paid of it. */
  totals: Array<{ currency: string; amountMinor: number; approvedMinor: number; paidMinor: number }>;
  canApprove: boolean;
  canPay: boolean;
}
