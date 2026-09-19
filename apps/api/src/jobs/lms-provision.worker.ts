import { logger } from "../lib/logger";
import { lmsConfigured, provisionEnrolment, LmsPermanentError } from "../lib/lms-client";
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
      row.set({
        status: "sent",
        lmsUserId: result.userId,
        lmsCourseSlug: result.courseSlug,
        studentCreated: result.created,
        sentAt: new Date(),
        lastError: undefined,
      });
      await row.save();
      sent++;
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

export function startLmsProvisionWorker(): void {
  if (!lmsConfigured()) {
    logger.info("LMS provisioning is not configured — approvals will not create students");
    return;
  }
  const run = () => {
    void drainLmsProvisions().catch((err) => logger.error({ err }, "LMS provisioning pass failed"));
  };
  setTimeout(run, 10_000);
  setInterval(run, EVERY_MS);
  logger.info("LMS provisioning worker started");
}
