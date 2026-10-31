import { z } from "zod";
import { expensePaymentMethodSchema } from "./expense.schema";

/*
 * The sales CRMs' commission in finance (the user, 2026-10-21: "commission of each CRM needs to show here, a manager
 * approves, then accounts mark it paid with the receipt"). Each CRM counts commission per sale (salesperson, team
 * leader, sales manager); finance reads a month of it through the Root portal, per CRM and person, and pays it:
 *
 *   earned    counted in the CRM — nothing to pay yet. What is paid is the CRM's My Pay "commission payable" (the
 *             commission earned × the person's salary-slab level percent — the user, 2026-10-21), not salary
 *   approved  a manager (tagged Manager in finance, or a super admin) approved the person's month — its amount frozen
 *   paid      accounts recorded the payment with its receipt — a paid expense in the books
 *
 * One payout per CRM, month and person across all of finance: it can never be paid twice.
 */

export const CRM_COMMISSION_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

const who = {
  crm: z.string().trim().min(1).max(40),
  month: z.string().regex(CRM_COMMISSION_MONTH, "month is YYYY-MM"),
  userId: z.string().trim().min(1).max(64),
};

export const approveCrmCommissionSchema = z.object({ ...who, note: z.string().trim().max(500).optional().default("") });
export type ApproveCrmCommissionInput = z.infer<typeof approveCrmCommissionSchema>;

export const revokeCrmCommissionSchema = z.object(who);
export type RevokeCrmCommissionInput = z.infer<typeof revokeCrmCommissionSchema>;

export const payCrmCommissionSchema = z.object({
  ...who,
  /** The day the money went. */
  paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the date it was paid"),
  paymentMethod: expensePaymentMethodSchema,
  reference: z.string().trim().max(120).optional().default(""),
  /** A managed expense-category slug for the expense it records. */
  category: z.string().trim().min(1, "Choose an expense category"),
  /** One of the category's subcategories (2026-10-21) — needed when it has any; the page's default fills it. */
  subcategory: z.string().trim().max(60).optional(),
  departmentId: z.union([z.literal(""), z.string().regex(/^[a-f\d]{24}$/i, "Invalid department")]).optional().default(""),
  /** The receipt, uploaded first (POST /commissions/crm/uploads) — required. */
  receipt: z.object({
    name: z.string().trim().min(1).max(200),
    key: z.string().min(1).max(400),
    size: z.number().int().min(0).optional(),
    mimeType: z.string().max(100).optional(),
  }, { message: "Attach the receipt" }),
});
export type PayCrmCommissionInput = z.infer<typeof payCrmCommissionSchema>;

export type CrmCommissionState = "earned" | "approved" | "paid";

export interface CrmCommissionLine {
  saleId: string; saleDate: string; student: string; course: string; invoiceNumber: string; role: string; amount: number;
  /** The CRM's student — the sale's invoice here by its external id (2026-10-31); absent from an older Root. */
  studentId?: string;
  /**
   * What the sale's invoice here has collected, and its total — minor units of the CRM's currency, null when no
   * invoice here matches (2026-10-26) or it is in a currency there is no rate for (2026-10-31).
   */
  collectedMinor?: number | null;
  feeMinor?: number | null;
  /** An invoice in another currency than the CRM's (a Bangalore sale's rupees): its currency and own figures. */
  invoiceCurrency?: string;
  invoiceCollectedMinor?: number;
  invoiceFeeMinor?: number;
}

/** Collected in a currency that couldn't be put in the CRM's — shown apart, never added in (2026-10-31). */
export interface CrmCommissionOtherMoney { currency: string; amountMinor: number }

export interface CrmCommissionPayoutView {
  state: "approved" | "paid";
  /** What was approved, frozen then. */
  amountMinor: number;
  approvedByName: string; approvedAt: string; approvalNote: string;
  paidByName?: string; paidOn?: string; paymentMethod?: string; reference?: string;
  expense?: { id: string; expenseNumber: string; status: string } | null;
  receipt?: { name: string; url: string } | null;
  /** The finance organization it was approved and paid in. */
  orgId: string; orgName: string;
}

export interface CrmCommissionPerson {
  userId: string; name: string; roles: string[];
  /**
   * What finance pays: the CRM's My Pay "commission payable" now — the commission earned × the person's slab level
   * percent (2026-10-21) — minor units; 0 while unknown (payableKnown false).
   */
  amountMinor: number;
  payableKnown: boolean;
  /** The commission earned it is a share of (every line added up), the level's percent and name. */
  earnedMinor: number;
  percent: number | null;
  level: string | null;
  sales: number;
  /** What their sales' invoices have collected (each sale once), minor units of the CRM's currency (2026-10-26). */
  collectedMinor: number;
  collectedOther?: CrmCommissionOtherMoney[];
  lines: CrmCommissionLine[];
  state: CrmCommissionState;
  payout: CrmCommissionPayoutView | null;
  /** Approved or paid at a different figure than the CRM counts now (a sale reversed or added since). */
  changed: boolean;
}

export interface CrmCommissionCrm {
  code: string; name: string; currency: string; error: string | null;
  /** Payable this month (My Pay's figures); the commission earned it comes from. */
  totalMinor: number;
  earnedTotalMinor: number;
  /** What the month's counted sales collected (each sale once, their invoices here), minor units (2026-10-26). */
  collectedTotalMinor: number;
  collectedOther?: CrmCommissionOtherMoney[];
  /** Why My Pay's figures are missing for this CRM, when they are — nothing can be approved then. */
  payError: string | null;
  pending: { progress: number; waiting: number };
  people: CrmCommissionPerson[];
}

export interface CrmCommissionMonth {
  month: string;
  crms: CrmCommissionCrm[];
  me: { canApprove: boolean; canPay: boolean };
}
