import { Types } from "mongoose";
import { OLD_BOOKS_SOURCE, formatMoney } from "@delta/shared";
import { logger } from "../lib/logger";
import { logEmail, sendInstalmentReminderEmail } from "../lib/email";
import { Invoice } from "../modules/invoice/invoice.model";
import { Customer } from "../modules/customer/customer.model";
import { Organization } from "../modules/organization/organization.model";
import { InstalmentReminder } from "../modules/invoice/instalment-reminder.model";
import { addDays, isoDay, REMINDER_OFFSETS, uaeDay, uaeHour } from "../modules/invoice/instalments";

/**
 * Reminds clients of a part-paid invoice's next instalment, 3, 2 and 1 day
 * before it is due (the user, 2026-10-11) — and, since 2026-10-16, on the day
 * and when it is overdue (3, 7, 14 days late, then weekly to 8 weeks), for
 * every programme (not only Forex) and invoices typed here too. A Forex
 * student's CS is told in Tetra Commission, as before.
 *
 * Once a day at 10:00 UAE, on a plain timer in the process that runs the
 * schedulers — not the reminder queue, which needs Redis. Never twice: each
 * (invoice, due date, days before) is claimed before it is sent, and the
 * balance is read again right before sending, so one paid in the meantime is
 * let go.
 */

const RUN_AT_UAE_HOUR = 10;
const CHECK_EVERY_MS = 5 * 60_000;

const longDate = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/**
 * A part-paid invoice, as the reminder needs it: sent, something paid and something left — an enrolment from a CRM
 * (approved) or one typed here (approved, or one that needs no approval).
 */
const APPROVED_STATES = ["approved", "not_required", null];
const OWING = {
  status: { $in: ["sent", "viewed", "partial", "overdue"] },
  balanceMinor: { $gt: 0 },
  amountPaidMinor: { $gt: 0 },
  "approval.state": { $in: APPROVED_STATES },
  // Never one brought in from the old books: its client is not to be chased from here (2026-10-21).
  "external.source": { $ne: OLD_BOOKS_SOURCE },
};

export interface InstalmentReminderRun {
  sent: number;
  skipped: number;
  failed: number;
  /** Already claimed by an earlier pass. */
  already: number;
}

/**
 * One pass for the UAE day `now` falls on: every part-paid invoice due 3, 2 or 1 days from today, today, or overdue
 * by one of the reminder days. Safe to run as often as you like — the claims make a second pass a no-op. `now` is a
 * parameter so the tests can travel.
 */
export async function runInstalmentReminders(now = new Date()): Promise<InstalmentReminderRun> {
  const out: InstalmentReminderRun = { sent: 0, skipped: 0, failed: 0, already: 0 };
  const today = uaeDay(now);
  for (const daysBefore of REMINDER_OFFSETS) {
    const dueDay = addDays(today, daysBefore);
    const candidates = await Invoice.find({ ...OWING, dueDate: { $gte: dueDay, $lt: addDays(dueDay, 1) } })
      .select("_id organizationId invoiceNumber")
      .lean<{ _id: Types.ObjectId; organizationId: Types.ObjectId; invoiceNumber: string }[]>();
    if (!candidates.length) continue;

    for (const candidate of candidates) {
      const dueOn = isoDay(dueDay);
      // Claimed before anything is sent: whoever gets here second moves on.
      try {
        await InstalmentReminder.create({
          organizationId: candidate.organizationId,
          invoiceId: candidate._id,
          invoiceNumber: candidate.invoiceNumber,
          dueOn,
          daysBefore,
          state: "claimed",
          claimedAt: new Date(),
        });
      } catch (err) {
        if ((err as { code?: number }).code === 11000) { out.already++; continue; }
        throw err;
      }
      const result = await sendOne(candidate._id, dueOn, daysBefore, dueDay);
      out[result]++;
    }
  }
  if (out.sent || out.failed) logger.info(out, "Instalment reminders sent");
  return out;
}

async function sendOne(invoiceId: Types.ObjectId, dueOn: string, daysBefore: number, dueDay: Date): Promise<"sent" | "skipped" | "failed"> {
  const claim = { invoiceId, dueOn, daysBefore };
  const settle = (state: "sent" | "skipped" | "failed", extra: Record<string, unknown> = {}) =>
    InstalmentReminder.updateOne(claim, { $set: { state, ...extra } });
  try {
    // Read again, right before sending: paid, voided or moved since the pass began is let go.
    const invoice = await Invoice.findById(invoiceId).lean<any>();
    const stillOwed = invoice
      && invoice.status !== "void"
      && APPROVED_STATES.includes(invoice.approval?.state ?? null)
      && (invoice.balanceMinor ?? 0) > 0
      && invoice.dueDate && isoDay(new Date(invoice.dueDate)) === dueOn;
    if (!stillOwed) {
      await settle("skipped", { reason: !invoice ? "Invoice deleted" : (invoice.balanceMinor ?? 0) <= 0 ? "Paid" : invoice.status === "void" ? "Voided" : "Due date moved" });
      return "skipped";
    }
    const [customer, org] = await Promise.all([
      Customer.findById(invoice.customerId).select("email name").lean<{ email?: string; name?: string } | null>(),
      Organization.findById(invoice.organizationId).lean<any>(),
    ]);
    const currency = invoice.currency ?? "AED";
    const balance = invoice.balanceMinor ?? 0;
    const to = (customer?.email ?? "").trim();
    const log = {
      organizationId: invoice.organizationId,
      kind: "instalment_reminder",
      ref: { type: "invoice", id: String(invoice._id), label: invoice.invoiceNumber },
    };
    // What it is for: the enrolment's course, else (an invoice typed here) its first line.
    const course = invoice.enrolment?.course || invoice.lineItems?.[0]?.description || "your course";
    if (!to) {
      await logEmail(log, { to: [], subject: `Instalment reminder for invoice ${invoice.invoiceNumber}`, result: { error: "no_recipients" } });
      await settle("failed", { reason: `${invoice.customerName} has no email address`, balanceMinor: balance, currency });
      return "failed";
    }
    const bankId = org?.invoiceDefaults?.bankAccountId;
    const bank = bankId && Types.ObjectId.isValid(bankId)
      ? await (await import("../modules/banking/bank-account.model")).BankAccount.findById(bankId).lean<any>()
      : null;
    const { error } = await sendInstalmentReminderEmail({
      to,
      orgName: org?.name ?? "Delta Finance",
      customerName: invoice.customerName ?? customer?.name ?? "",
      course,
      invoiceNumber: invoice.invoiceNumber,
      balance: formatMoney(balance, currency),
      total: formatMoney(invoice.totalMinor ?? 0, currency),
      paid: formatMoney(invoice.amountPaidMinor ?? 0, currency),
      dueDate: dueOn,
      dueDateLong: longDate(dueDay),
      daysBefore,
      contactEmail: org?.email || undefined,
      contactPhone: org?.phone || undefined,
      bank: bank ? { name: bank.bankName, accountName: bank.accountName, accountNumber: bank.accountNumber, iban: bank.iban, swift: bank.swift } : null,
      logoUrl: org?.branding?.logoUrl || undefined,
      footerText: org?.branding?.footerText || undefined,
      log,
    });
    if (error) {
      await settle("failed", { to, reason: error, balanceMinor: balance, currency });
      return "failed";
    }
    await settle("sent", { to, sentAt: new Date(), balanceMinor: balance, currency });
    return "sent";
  } catch (err) {
    logger.error({ err, invoiceId: String(invoiceId), dueOn, daysBefore }, "Could not send an instalment reminder");
    await settle("failed", { reason: (err as Error).message?.slice(0, 300) }).catch(() => undefined);
    return "failed";
  }
}

/*
 * The daily timer. Checked every few minutes; once it is 10:00 or later in the
 * UAE and today's pass has not run in this process, it runs. A restart later in
 * the day still sends that day's; the claims stop a second process or a second
 * pass from sending anything twice.
 */
let lastDay = "";
let running = false;

async function tick(): Promise<void> {
  const now = new Date();
  if (running || uaeHour(now) < RUN_AT_UAE_HOUR) return;
  const day = isoDay(uaeDay(now));
  if (day === lastDay) return;
  running = true;
  try {
    await runInstalmentReminders(now);
    lastDay = day;
  } catch (err) {
    logger.error({ err }, "Instalment reminders pass failed — tried again shortly");
  } finally {
    running = false;
  }
}

export function startInstalmentReminderWorker(): void {
  setTimeout(() => void tick(), 30_000);
  setInterval(() => void tick(), CHECK_EVERY_MS);
  logger.info("Instalment reminders worker started — daily at 10:00 UAE");
}
