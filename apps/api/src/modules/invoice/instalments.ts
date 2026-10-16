/**
 * Partial payments: the next instalment is due 29 days after the money was
 * actually paid (the user, 2026-10-11).
 *
 * For an enrolment from a sales CRM that is part paid — approved, a balance
 * left, not void — the due date is the latest payment's `paidOn` (its UTC
 * date) plus 29 calendar days. Every payment restarts the 29 days until the
 * balance is nothing; paid in full, the due date is left where it was.
 *
 * Pure: no database, no clock. The callers (approval, recording, editing or
 * deleting a payment) set what this answers before they save.
 */

export const INSTALMENT_DAYS = 29;

/** The systems whose enrolments these are — the same three the LMS provisioning takes. */
const CRM_SOURCES = new Set(["crm", "draw-crm", "banglore-crm"]);

const DAY_MS = 86_400_000;

export interface InstalmentInvoice {
  status?: string | null;
  balanceMinor?: number | null;
  approval?: { state?: string | null } | null;
  external?: { source?: string | null } | null;
  enrolment?: { course?: string | null } | null;
  payments?: ReadonlyArray<{ paidOn?: Date | string | null } | null> | null;
}

/** An invoice billing an enrolment that came from a sales CRM (or carries one). */
export function isCrmEnrolmentInvoice(invoice: InstalmentInvoice): boolean {
  const source = invoice.external?.source ?? "";
  return CRM_SOURCES.has(source) || Boolean(invoice.enrolment?.course);
}

/** Midnight UTC of the day `d` falls on (UTC). */
export function utcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY_MS);
}

/** "YYYY-MM-DD" of a date, by its UTC day. */
export const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** The latest payment's paidOn, or null when there is none that reads as a date. */
export function latestPaidOn(invoice: InstalmentInvoice): Date | null {
  let latest: Date | null = null;
  for (const p of invoice.payments ?? []) {
    if (!p?.paidOn) continue;
    const d = p.paidOn instanceof Date ? p.paidOn : new Date(p.paidOn);
    if (Number.isNaN(d.getTime())) continue;
    if (!latest || d.getTime() > latest.getTime()) latest = d;
  }
  return latest;
}

/**
 * The due date of the next instalment, or null where the rule does not apply
 * (not a CRM enrolment, not approved, void, paid in full, nothing paid yet) —
 * null meaning "leave the due date as it is".
 */
export function nextInstalmentDue(invoice: InstalmentInvoice): Date | null {
  if (!isCrmEnrolmentInvoice(invoice)) return null;
  if (invoice.approval?.state !== "approved") return null;
  if (invoice.status === "void") return null;
  if ((invoice.balanceMinor ?? 0) <= 0) return null;
  const paidOn = latestPaidOn(invoice);
  if (!paidOn) return null;
  return addDays(utcDay(paidOn), INSTALMENT_DAYS);
}

/**
 * Sets the due date by the rule on a document about to be saved. True when it
 * changed — which is a money change Tetra Commission is told about.
 */
export function applyInstalmentDue(doc: InstalmentInvoice & { dueDate?: Date | null; set?: (path: string, value: unknown) => unknown }): boolean {
  const due = nextInstalmentDue(doc);
  if (!due) return false;
  if (doc.dueDate && new Date(doc.dueDate).getTime() === due.getTime()) return false;
  if (typeof doc.set === "function") doc.set("dueDate", due);
  else doc.dueDate = due;
  return true;
}

/* ── The UAE day, for the reminders ──────────────────────────────────────── */

/** The UAE is UTC+4 all year — no daylight saving. */
const UAE_OFFSET_MS = 4 * 3_600_000;

/** The UAE calendar day `now` falls on, as midnight UTC of that date. */
export function uaeDay(now: Date): Date {
  return utcDay(new Date(now.getTime() + UAE_OFFSET_MS));
}

/** The hour of the day in the UAE (0–23). */
export function uaeHour(now: Date): number {
  return new Date(now.getTime() + UAE_OFFSET_MS).getUTCHours();
}

/** How many days before an instalment is due its client is reminded. */
export const REMINDER_DAYS_BEFORE = [3, 2, 1] as const;

/**
 * Every reminder, by days before the due date (the user, 2026-10-16: "and overdue too"): 3, 2 and 1 day before; on
 * the day (0); then late — negative — by 3, 7 and 14 days, and every week after that up to 8 weeks.
 */
export const REMINDER_OFFSETS = [...REMINDER_DAYS_BEFORE, 0, -3, -7, -14, -21, -28, -35, -42, -49, -56] as const;
