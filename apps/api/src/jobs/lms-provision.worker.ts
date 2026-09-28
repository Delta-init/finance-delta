import { logger } from "../lib/logger";
import { lmsConfigured, provisionEnrolment, updateEnrolmentAccess, LmsPermanentError, type LmsPaymentStatus } from "../lib/lms-client";
import { LmsProvision } from "../modules/integrations/lms-provision.model";

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
        studentCreated: result.created,
        sentAt: new Date(),
        lastError: undefined,
        ...(sentStatus ? { "access.sent": sentStatus } : {}),
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

export function startLmsProvisionWorker(): void {
  if (!lmsConfigured()) {
    logger.info("LMS provisioning is not configured — approvals will not create students");
    return;
  }
  const run = () => {
    void drainLmsProvisions()
      .then(() => drainLmsAccessUpdates())
      .catch((err) => logger.error({ err }, "LMS provisioning pass failed"));
  };
  setTimeout(run, 10_000);
  setInterval(run, EVERY_MS);
  logger.info("LMS provisioning worker started");
}
