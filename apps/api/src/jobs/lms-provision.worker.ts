import { logger } from "../lib/logger";
import { lmsConfigured, provisionEnrolment, updateEnrolmentAccess, LmsPermanentError, type LmsPaymentStatus } from "../lib/lms-client";
import {
  commissionConfigured, sendStudentToCommission, CommissionPermanentError, CommissionNotReadyError, logCommissionConfig,
} from "../lib/commission-client";
import { LmsProvision } from "../modules/integrations/lms-provision.model";
import { Invoice } from "../modules/invoice/invoice.model";
import { Customer } from "../modules/customer/customer.model";

/**
 * Delivers approved enrolments to the LMS.
 *
 * A plain timer rather than a queue server. The volume is a handful of
 * enrolments a day, the work is one HTTP call each, and the alternative —
 * requiring Redis — would mean an installation without it silently provisions
 * nobody, which is the failure the reminders already have and nobody noticed
 * for months.
 */

const EVERY_MS = 60_000;
const BATCH = 20;
const MAX_ATTEMPTS = 8;

/** Backs off to roughly a quarter of an hour, then stays there. */
function backoffMs(attempts: number): number {
  return Math.min(2 ** attempts * 1000, 15 * 60_000);
}

export async function drainLmsProvisions(): Promise<number> {
  if (!lmsConfigured()) return 0;

  const due = await LmsProvision.find({ status: "pending", nextAttemptAt: { $lte: new Date() } })
    .sort({ nextAttemptAt: 1 })
    .limit(BATCH);

  let sent = 0;
  for (const row of due) {
    try {
      const result = await provisionEnrolment(row.payload as never);
      const sentStatus = (row.payload as { paymentStatus?: LmsPaymentStatus } | undefined)?.paymentStatus;
      row.set({
        status: "sent",
        lmsUserId: result.userId,
        lmsCourseSlug: result.courseSlug,
        lmsCourseTitle: result.courseTitle,
        studentCreated: result.created,
        sentAt: new Date(),
        lastError: undefined,
        ...(sentStatus ? { "access.sent": sentStatus } : {}),
        // On to Tetra Commission, if it is switched on now. New students only:
        // one the LMS took before this, or while it was off, is never sent.
        ...(commissionConfigured() && !row.commission?.state
          ? { "commission.state": "pending", "commission.attempts": 0, "commission.nextAttemptAt": new Date() }
          : {}),
      });
      await row.save();
      sent++;

      // A payment recorded while this was on its way raised the status after
      // it was read: send that too, rather than leave the LMS a step behind.
      const fresh = await LmsProvision.findById(row._id).select("payload").lean();
      const latest = (fresh?.payload as { paymentStatus?: LmsPaymentStatus } | undefined)?.paymentStatus;
      if (sentStatus && latest && RANK[latest] > RANK[sentStatus]) {
        await LmsProvision.updateOne({ _id: row._id }, { $set: { "access.pending": latest, "access.attempts": 0, "access.nextAttemptAt": new Date() } });
      }
      logger.info(
        { invoice: row.invoiceNumber, lmsUserId: result.userId, course: result.courseSlug, repeat: result.alreadyProcessed },
        "Enrolment provisioned in the LMS",
      );
    } catch (err) {
      const permanent = err instanceof LmsPermanentError;
      const attempts = (row.attempts ?? 0) + 1;
      row.set({
        attempts,
        lastError: (err as Error).message?.slice(0, 500),
        // A malformed payload or an unknown course fails identically forever.
        // Somebody has to map it; retrying every minute only buries the rows
        // that would have worked.
        status: permanent || attempts >= MAX_ATTEMPTS ? "failed" : "pending",
        nextAttemptAt: new Date(Date.now() + backoffMs(attempts)),
      });
      await row.save();
      logger.warn(
        { invoice: row.invoiceNumber, attempts, permanent, err: (err as Error).message },
        "Could not provision an enrolment in the LMS",
      );
    }
  }
  return sent;
}

const RANK: Record<LmsPaymentStatus, number> = { unpaid: 0, partial: 1, paid: 2 };

/**
 * Sends the follow-ups: an enrolment already in the LMS whose fee is now more
 * paid. The LMS opens more of the course; this only records that it was told.
 * Cleared only when nothing newer arrived while the call was on its way.
 */
export async function drainLmsAccessUpdates(): Promise<number> {
  if (!lmsConfigured()) return 0;

  const due = await LmsProvision.find({
    status: "sent",
    "access.pending": { $in: ["unpaid", "partial", "paid"] },
    $or: [{ "access.nextAttemptAt": { $lte: new Date() } }, { "access.nextAttemptAt": null }],
  }).limit(BATCH);

  let sent = 0;
  for (const row of due) {
    const status = row.access!.pending as LmsPaymentStatus;
    try {
      const result = await updateEnrolmentAccess({ invoiceId: String(row.invoiceId), paymentStatus: status });
      await LmsProvision.updateOne(
        { _id: row._id, "access.pending": status },
        { $set: { "access.sent": status, "access.attempts": 0 }, $unset: { "access.pending": 1, "access.lastError": 1, "access.nextAttemptAt": 1 } },
      );
      sent++;
      logger.info(
        { invoice: row.invoiceNumber, status, openModules: result.openModules, totalModules: result.totalModules, changed: result.changed },
        "LMS access updated after a payment",
      );
    } catch (err) {
      const permanent = err instanceof LmsPermanentError;
      const attempts = (row.access?.attempts ?? 0) + 1;
      const message = (err as Error).message?.slice(0, 500);
      await LmsProvision.updateOne(
        { _id: row._id, "access.pending": status },
        permanent || attempts >= MAX_ATTEMPTS
          ? { $set: { "access.lastError": message, "access.attempts": attempts }, $unset: { "access.pending": 1 } }
          : { $set: { "access.lastError": message, "access.attempts": attempts, "access.nextAttemptAt": new Date(Date.now() + backoffMs(attempts)) } },
      );
      logger.warn({ invoice: row.invoiceNumber, attempts, permanent, err: message }, "Could not update LMS access after a payment");
    }
  }
  return sent;
}

/**
 * Sends each new LMS student on to Tetra Commission, where the next team in
 * turn is given them (team 1, 2, 3, 4, then team 1 again).
 *
 * Only rows the LMS has taken, oldest first, so the teams take turns in the
 * order the students arrived. Tetra Commission is idempotent on the invoice
 * and leaves an email it already has alone, so a retry is always safe. Kept
 * apart from the LMS step: this failing never holds up or repeats that one.
 */
export async function drainCommissionStudents(): Promise<number> {
  if (!commissionConfigured()) return 0;

  const due = await LmsProvision.find({
    status: "sent",
    "commission.state": "pending",
    $or: [{ "commission.nextAttemptAt": { $lte: new Date() } }, { "commission.nextAttemptAt": null }],
  })
    .sort({ sentAt: 1 })
    .limit(BATCH);

  let sent = 0;
  for (const row of due) {
    const payload = (row.payload ?? {}) as { email?: string; name?: string; phone?: string; courseSlug?: string };
    try {
      const result = await sendStudentToCommission({
        invoiceId: String(row.invoiceId),
        invoiceNumber: row.invoiceNumber ?? "",
        email: payload.email ?? "",
        name: payload.name,
        phone: payload.phone,
        country: await customerCountry(row.invoiceId),
        course: row.lmsCourseTitle || row.lmsCourseSlug || payload.courseSlug,
        lmsUserId: row.lmsUserId ?? undefined,
      });
      await LmsProvision.updateOne(
        { _id: row._id, "commission.state": "pending" },
        {
          $set: {
            "commission.state": "sent",
            "commission.studentId": result.studentId,
            "commission.studentCode": result.studentCode,
            "commission.alreadyThere": result.existing === "email",
            // Kept from the first answer: a later re-send finds the student and names no team.
            ...(result.teamName ? { "commission.team": result.teamName } : {}),
            "commission.mentorName": result.mentorName,
            "commission.sentAt": new Date(),
          },
          $unset: { "commission.lastError": 1, "commission.nextAttemptAt": 1 },
        },
      );
      sent++;
      logger.info(
        { invoice: row.invoiceNumber, student: result.studentCode, mentor: result.mentorName, existing: result.existing },
        result.existing === "email" ? "Student already in Tetra Commission — left as they are" : "Student sent to Tetra Commission",
      );
    } catch (err) {
      const permanent = err instanceof CommissionPermanentError;
      const notReady = err instanceof CommissionNotReadyError;
      const attempts = (row.commission?.attempts ?? 0) + 1;
      const message = (err as Error).message?.slice(0, 500);
      // Not deployed or not configured there yet waits for as long as that
      // takes; anything else gets the LMS step's allowance.
      const giveUp = permanent || (!notReady && attempts >= MAX_ATTEMPTS);
      await LmsProvision.updateOne(
        { _id: row._id, "commission.state": "pending" },
        {
          $set: {
            "commission.state": giveUp ? "failed" : "pending",
            "commission.attempts": attempts,
            "commission.lastError": message,
            "commission.nextAttemptAt": new Date(Date.now() + backoffMs(attempts)),
          },
        },
      );
      logger.warn({ invoice: row.invoiceNumber, attempts, permanent, notReady, err: message }, "Could not send a student to Tetra Commission");
    }
  }
  return sent;
}

/** The student's country, as accounts have it on the customer — read when sent, so it is current. */
async function customerCountry(invoiceId: unknown): Promise<string> {
  const invoice = await Invoice.findById(invoiceId).select("customerId").lean<{ customerId?: unknown } | null>();
  if (!invoice?.customerId) return "";
  const customer = await Customer.findById(invoice.customerId).select("country").lean<{ country?: string } | null>();
  return customer?.country?.trim() ?? "";
}

export function startLmsProvisionWorker(): void {
  if (!lmsConfigured()) {
    logger.info("LMS provisioning is not configured — approvals will not create students");
    return;
  }
  logCommissionConfig();
  // One pass at a time: a slow LMS or Tetra Commission must not let the next
  // tick start on the same rows while this one is still sending them.
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    void drainLmsProvisions()
      .then(() => drainLmsAccessUpdates())
      .then(() => drainCommissionStudents())
      .catch((err) => logger.error({ err }, "LMS provisioning pass failed"))
      .finally(() => { running = false; });
  };
  setTimeout(run, 10_000);
  setInterval(run, EVERY_MS);
  logger.info("LMS provisioning worker started");
}
