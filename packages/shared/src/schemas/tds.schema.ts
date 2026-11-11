import { z } from "zod";

/*
 * TDS — tax deducted at source — on vendor bills, for the Bangalore organization only (the user, 2026-11-11: "TDS
 * section required", "is only for the bangalore only"). Offered where the organization keeps its books in INR. A bill
 * names a TDS section; the TDS is worked out on the bill before GST, rounded to the rupee, and comes off what the
 * vendor is paid — the bill's balance is its total less the TDS. The TDS is owed to the government until it is paid
 * (recorded as a TDS payment, from a Banking account).
 */

export const tdsSectionSchema = z.object({
  /** e.g. "194C-O" — what bills and vendors name. */
  code: z.string().trim().min(1, "Code is required").max(20),
  /** e.g. "194C — Contractors (company / firm)". */
  label: z.string().trim().min(1, "Name is required").max(120),
  ratePct: z.number().min(0).max(100),
  active: z.boolean().default(true),
});
export type TdsSection = z.infer<typeof tdsSectionSchema>;

/** The usual sections, to start from — the rates are checked and changed in Settings → Taxes. */
export const TDS_DEFAULT_SECTIONS: TdsSection[] = [
  { code: "194C-I", label: "194C — Contractors (individual / HUF)", ratePct: 1, active: true },
  { code: "194C-O", label: "194C — Contractors (company / firm)", ratePct: 2, active: true },
  { code: "194J-P", label: "194J — Professional fees", ratePct: 10, active: true },
  { code: "194J-T", label: "194J — Technical services", ratePct: 2, active: true },
  { code: "194I-B", label: "194I — Rent of land, building, furniture", ratePct: 10, active: true },
  { code: "194I-M", label: "194I — Rent of plant, machinery", ratePct: 2, active: true },
  { code: "194H", label: "194H — Commission / brokerage", ratePct: 2, active: true },
  { code: "194Q", label: "194Q — Purchase of goods", ratePct: 0.1, active: true },
];

export const tdsConfigSchema = z.object({
  /** Offered at all: the organization keeps its books in INR (Bangalore). */
  available: z.boolean(),
  enabled: z.boolean(),
  sections: z.array(tdsSectionSchema),
});
export type TdsConfig = z.infer<typeof tdsConfigSchema>;

export const updateTdsConfigSchema = z.object({
  enabled: z.boolean().optional(),
  sections: z.array(tdsSectionSchema).max(40).optional()
    .refine((s) => !s || new Set(s.map((x) => x.code.toUpperCase())).size === s.length, "Each section needs its own code"),
});
export type UpdateTdsConfigInput = z.infer<typeof updateTdsConfigSchema>;

/** What a bill carries: the section, its rate then, what it was worked out on, and the TDS. */
export const billTdsSchema = z.object({
  section: z.string(),
  label: z.string(),
  ratePct: z.number(),
  baseMinor: z.number(),
  amountMinor: z.number(),
});
export type BillTds = z.infer<typeof billTdsSchema>;

/** TDS on an amount before GST, rounded to the whole rupee (section 288B). */
export function tdsMinorOf(baseMinor: number, ratePct: number): number {
  if (!(baseMinor > 0) || !(ratePct > 0)) return 0;
  return Math.round((baseMinor * ratePct) / 100 / 100) * 100;
}

export const recordTdsPaymentSchema = z.object({
  /** The month the TDS was deducted in, "YYYY-MM". */
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Pick the month"),
  /** One section, or "" for the month's TDS together. */
  section: z.string().max(20).optional().default(""),
  amountMinor: z.number().int().positive("Amount must be more than 0"),
  paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Payment date required"),
  bankAccountId: z.string().min(1, "Choose the account it was paid from"),
  challanNo: z.string().trim().max(60).optional().default(""),
  notes: z.string().max(500).optional().default(""),
});
export type RecordTdsPaymentInput = z.infer<typeof recordTdsPaymentSchema>;

export const tdsReportQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export type TdsReportQuery = z.infer<typeof tdsReportQuerySchema>;

export interface TdsReportRow {
  /** "YYYY-MM" and the section code. */
  period: string; section: string; label: string;
  bills: number; baseMinor: number; tdsMinor: number; paidMinor: number; owedMinor: number;
}
export interface TdsBillRow {
  id: string; billNumber: string; billDate: string; vendorName: string; pan: string; section: string; ratePct: number;
  baseMinor: number; tdsMinor: number; status: string;
}
export interface TdsPaymentRow {
  id: string; period: string; section: string; amountMinor: number; paidOn: string; accountName: string; challanNo: string; notes: string; inBank: boolean;
}
export interface TdsReport {
  currency: string;
  rows: TdsReportRow[];
  bills: TdsBillRow[];
  payments: TdsPaymentRow[];
  totals: { baseMinor: number; tdsMinor: number; paidMinor: number; owedMinor: number };
}
