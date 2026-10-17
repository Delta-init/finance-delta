import { z } from "zod";

/*
 * Late entries (the user, 2026-10-17: "when any old expense is entered a request goes to the managers … only
 * Manager-tagged users see the page, only they approve or reject … and a reason has to be entered"):
 *
 * An expense, a bill, a bill payment or an invoice payment typed in with a date more than the organization's
 * `lateEntryDays` back (7 unless set; 0 turns it off) needs a reason, and waits for a manager — somebody tagged Manager
 * in this organization, or a super admin — who approves it or rejects it with a reason of their own. Nobody decides
 * their own. Entries other parts of finance make (approvals, HRMS, payroll, Tetra Commission) are not asked.
 */

export const LATE_ENTRY_KINDS = ["expense", "bill", "bill_payment", "invoice_payment"] as const;
export type LateEntryKind = (typeof LATE_ENTRY_KINDS)[number];
export const LATE_ENTRY_STATES = ["pending", "approved", "rejected", "withdrawn"] as const;
export type LateEntryState = (typeof LATE_ENTRY_STATES)[number];
export const DEFAULT_LATE_ENTRY_DAYS = 7;

/** What each kind is called on the page. */
export const LATE_ENTRY_KIND_LABELS: Record<LateEntryKind, string> = {
  expense: "Expense",
  bill: "Bill",
  bill_payment: "Bill payment",
  invoice_payment: "Invoice payment",
};

const DUBAI_OFFSET_MS = 4 * 60 * 60 * 1000;
const dayOf = (d: string | Date) => (typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10));

/** The earliest day that is not late: today in Dubai, less `days`, as YYYY-MM-DD. */
export function lateEntryCutoff(days: number, now: Date = new Date()): string {
  const today = new Date(now.getTime() + DUBAI_OFFSET_MS);
  today.setUTCHours(0, 0, 0, 0);
  return new Date(today.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

/** Dated before the cutoff — more than `days` days back. Never late when `days` is 0 or less. */
export function isLateDate(date: string | Date | null | undefined, days: number, now: Date = new Date()): boolean {
  if (!date || !(days > 0)) return false;
  const day = dayOf(date);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && day < lateEntryCutoff(days, now);
}

/** The reason given for typing it in late — asked for only when it is. */
export const lateReasonSchema = z.string().trim().max(500).optional();

/** What a record says of its own late entry. */
export const recordLateEntrySchema = z.object({
  state: z.enum(LATE_ENTRY_STATES),
  reason: z.string(),
  enteredByName: z.string(),
  decidedByName: z.string().optional(),
  decisionNote: z.string().optional(),
});
export type RecordLateEntry = z.infer<typeof recordLateEntrySchema>;

export const lateEntrySchema = z.object({
  id: z.string(),
  kind: z.enum(LATE_ENTRY_KINDS),
  refId: z.string(),
  paymentId: z.string().optional(),
  number: z.string(),
  title: z.string(),
  amountMinor: z.number(),
  currency: z.string(),
  /** The date that made it late, and the one it had before when an edit moved it there. */
  date: z.string(),
  previousDate: z.string().optional(),
  reason: z.string(),
  state: z.enum(LATE_ENTRY_STATES),
  enteredById: z.string(),
  enteredByName: z.string(),
  enteredAt: z.string(),
  decidedByName: z.string().optional(),
  decidedAt: z.string().optional(),
  decisionNote: z.string().optional(),
  /** Where the record is in finance. */
  href: z.string(),
  /** False for the person who entered it: somebody else decides it. */
  canDecide: z.boolean(),
});
export type LateEntry = z.infer<typeof lateEntrySchema>;

export const lateEntryQuerySchema = z.object({
  state: z.enum(["pending", "decided"]).default("pending"),
});
export type LateEntryQuery = z.infer<typeof lateEntryQuerySchema>;

export const decideLateEntrySchema = z.object({
  note: z.string().trim().max(500).optional().default(""),
});
export type DecideLateEntryInput = z.infer<typeof decideLateEntrySchema>;

/** The reader: whether they decide late entries, how many wait, and the organization's rule. */
export const lateEntryMeSchema = z.object({
  isManager: z.boolean(),
  pending: z.number(),
  days: z.number(),
});
export type LateEntryMe = z.infer<typeof lateEntryMeSchema>;
