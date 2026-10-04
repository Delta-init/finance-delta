import { enrolmentCrm, type EnrolmentCrm } from "@delta/shared";
import { logger } from "../lib/logger";
import {
  lmsConfigured, provisionEnrolment, updateEnrolmentAccess, LmsPermanentError, type LmsPaymentStatus, type EnrolmentFeeSummary,
} from "../lib/lms-client";
import {
  commissionConfigured, sendStudentToCommission, CommissionPermanentError, CommissionNotReadyError, logCommissionConfig,
} from "../lib/commission-client";
import { LmsProvision, extraCourseKey } from "../modules/integrations/lms-provision.model";
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
 *
 * Sent straight after an approval or a payment (kickLmsProvisioning), in the
 * background, so the student is in the LMS and in Tetra Commission within
 * seconds; the timer is the safety net that retries whatever that could not
 * deliver.
 */

const EVERY_MS = 60_000;
const BATCH = 20;

/**
 * Whose students go on to Tetra Commission: the sales CRMs' — Delta's and the
 * Remote CRM's ("crm") and, since 2026-10-03, Draw's ("draw-crm"), whose
 * students join the same round of teams and get a CS like anybody else's. A
 * row from before `source` was kept is Delta's.
 */
const COMMISSION_SOURCES = new Set(["crm", "draw-crm"]);
const sendsToCommission = (source: unknown) => COMMISSION_SOURCES.has(String(source ?? "crm"));

/**
 * And only Forex students: Tetra Commission is the trading side's. The LMS
 * names each course's programme when it takes the enrolment, and FOREX Trading
 * is `4x-trading` there. Any other programme — Digital Marketing, AI, JURA — or
 * none, and the student is not sent. An LMS too old to name it counts as none,
 * which is why the LMS goes live with this before finance does.
 */
const FOREX_PROGRAMME = "4x-trading";
const isForex = (program: unknown) => program === FOREX_PROGRAMME;
const notForex = (program: string | null | undefined) =>
  program === undefined ? "The LMS did not say which programme the course is in" : `Not a Forex course (${program || "no programme set"})`;

/**
 * Backs off to roughly a quarter of an hour, then stays there — and keeps
 * trying. An outage is waited out however long it lasts: giving up after a
 * few minutes left students who were never created unless somebody re-queued
 * them by hand. Only a refusal that cannot come right (a 4xx) stops.
 */
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
        ...(result.courseProgram ? { lmsCourseProgram: result.courseProgram } : {}),
        studentCreated: result.created,
        sentAt: new Date(),
        lastError: undefined,
        ...(sentStatus ? { "access.sent": sentStatus } : {}),
        // On to Tetra Commission, if it is switched on now and the course is
        // Forex. New students only: one the LMS took before this, or while it
        // was off, is never sent. One on another programme is marked, with why.
        ...(commissionConfigured() && !row.commission?.state && sendsToCommission(row.source)
          ? isForex(result.courseProgram)
            ? { "commission.state": "pending", "commission.attempts": 0, "commission.nextAttemptAt": new Date() }
            : { "commission.state": "skipped", "commission.reason": notForex(result.courseProgram) }
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
        // that would have worked. Anything else is waited out.
        status: permanent ? "failed" : "pending",
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
 * The invoice's other courses — a bundle's second, or a second course sold on
 * the same invoice — once the first has made the student. Each goes under its
 * own key, as much of it open as the fee now pays for, and is retried or
 * stopped on its own, exactly as the first is.
 */
export async function drainLmsExtraCourses(): Promise<number> {
  if (!lmsConfigured()) return 0;
  const now = new Date();
  const due = await LmsProvision.find({
    status: "sent",
    extraCourses: { $elemMatch: { status: "pending", nextAttemptAt: { $lte: now } } },
  }).limit(BATCH);

  let sent = 0;
  for (const row of due) {
    const payload = (row.payload ?? {}) as Record<string, unknown> & { paymentStatus?: LmsPaymentStatus };
    // As paid as the first course was last told, or is about to be.
    const known = [row.access?.pending, row.access?.sent, payload.paymentStatus].filter(Boolean) as LmsPaymentStatus[];
    const paymentStatus = known.sort((a, b) => RANK[b] - RANK[a])[0];
    for (const extra of (row.extraCourses ?? []).filter((e) => e.status === "pending" && (!e.nextAttemptAt || e.nextAttemptAt <= now))) {
      const at = { arrayFilters: [{ "e.slug": extra.slug }] };
      try {
        // The invoice's money is the first course's: its order and its fee
        // summary. Repeated on every course it would be revenue twice, and a
        // bundle's second course would show a fee nobody owes again.
        const { feeSummary: _summary, amountMinor: _minor, ...first } = payload as Record<string, unknown>;
        const result = await provisionEnrolment({
          ...(first as never as { email: string }),
          courseSlug: extra.slug,
          invoiceId: extraCourseKey(row.invoiceId, extra.slug),
          amount: 0,
          amountMinor: 0,
          ...(paymentStatus ? { paymentStatus } : {}),
        } as never);
        await LmsProvision.updateOne({ _id: row._id }, {
          $set: {
            "extraCourses.$[e].status": "sent",
            "extraCourses.$[e].sentAt": new Date(),
            "extraCourses.$[e].lmsCourseTitle": result.courseTitle,
            ...(paymentStatus ? { "extraCourses.$[e].accessSent": paymentStatus } : {}),
          },
          $unset: { "extraCourses.$[e].lastError": 1 },
        }, at);
        // A Forex course after a first that was not: a Forex student after all,
        // sent under this course. Only one passed over for its programme —
        // never one from before Tetra Commission was switched on.
        if (commissionConfigured() && isForex(result.courseProgram)) {
          await LmsProvision.updateOne(
            { _id: row._id, "commission.state": "skipped" },
            {
              $set: { "commission.state": "pending", "commission.course": result.courseTitle, "commission.attempts": 0, "commission.nextAttemptAt": new Date() },
              $unset: { "commission.reason": 1 },
            },
          );
        }
        sent++;
        logger.info({ invoice: row.invoiceNumber, course: result.courseSlug, repeat: result.alreadyProcessed }, "Further course of an enrolment provisioned in the LMS");
      } catch (err) {
        const permanent = err instanceof LmsPermanentError;
        const attempts = (extra.attempts ?? 0) + 1;
        await LmsProvision.updateOne({ _id: row._id }, {
          $set: {
            "extraCourses.$[e].status": permanent ? "failed" : "pending",
            "extraCourses.$[e].attempts": attempts,
            "extraCourses.$[e].lastError": (err as Error).message?.slice(0, 500),
            "extraCourses.$[e].nextAttemptAt": new Date(Date.now() + backoffMs(attempts)),
          },
        }, at);
        logger.warn({ invoice: row.invoiceNumber, course: extra.slug, attempts, permanent, err: (err as Error).message }, "Could not provision a further course in the LMS");
      }
    }
  }
  return sent;
}

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
      /*
       * Then the invoice's other courses already in the LMS. The LMS only ever
       * opens, so telling the first course again on a retry changes nothing —
       * which is what lets one that could not be reached keep the whole row
       * waiting rather than need a queue of its own. One the LMS will never
       * take the news for is noted on the course and let go.
       */
      for (const extra of (row.extraCourses ?? []).filter((e) => e.status === "sent" && (!e.accessSent || RANK[e.accessSent as LmsPaymentStatus] < RANK[status]))) {
        try {
          await updateEnrolmentAccess({ invoiceId: extraCourseKey(row.invoiceId, extra.slug), paymentStatus: status });
          await LmsProvision.updateOne({ _id: row._id }, { $set: { "extraCourses.$[e].accessSent": status }, $unset: { "extraCourses.$[e].lastError": 1 } }, { arrayFilters: [{ "e.slug": extra.slug }] });
        } catch (err) {
          if (!(err instanceof LmsPermanentError)) throw err;
          await LmsProvision.updateOne({ _id: row._id }, { $set: { "extraCourses.$[e].lastError": (err as Error).message?.slice(0, 500) } }, { arrayFilters: [{ "e.slug": extra.slug }] });
        }
      }
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
        permanent
          ? { $set: { "access.lastError": message, "access.attempts": attempts }, $unset: { "access.pending": 1 } }
          : { $set: { "access.lastError": message, "access.attempts": attempts, "access.nextAttemptAt": new Date(Date.now() + backoffMs(attempts)) } },
      );
      logger.warn({ invoice: row.invoiceNumber, attempts, permanent, err: message }, "Could not update LMS access after a payment");
    }
  }
  return sent;
}

/**
 * Sends each new Forex student the LMS took on to Tetra Commission, where the
 * next team in turn is given them (team 1, 2, 3, 4, then team 1 again).
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
    const payload = (row.payload ?? {}) as {
      email?: string; name?: string; phone?: string; courseSlug?: string; feeSummary?: EnrolmentFeeSummary;
    };
    try {
      const language = await enrolmentLanguage(row.invoiceId);
      const crm = await enrolmentSaleCrm(row.invoiceId);
      const closedBy = await enrolmentCloser(row.invoiceId, crm);
      const result = await sendStudentToCommission({
        invoiceId: String(row.invoiceId),
        invoiceNumber: row.invoiceNumber ?? "",
        email: payload.email ?? "",
        name: payload.name,
        phone: payload.phone,
        country: await customerCountry(row.invoiceId),
        course: row.commission?.course || row.lmsCourseTitle || row.lmsCourseSlug || payload.courseSlug,
        ...(language ? { language } : {}),
        // Which sales CRM sold it — shown as a tag on the student there.
        ...(crm ? { crm } : {}),
        // Who closed it: shown on the student there, and their Sales account sees the students they closed.
        ...(closedBy ? { closedBy } : {}),
        lmsUserId: row.lmsUserId ?? undefined,
        // The same summary the LMS was given; absent on rows queued before it existed.
        ...(payload.feeSummary ? { feeSummary: payload.feeSummary } : {}),
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
      // Down, not deployed, or not configured there yet: waited out, however
      // long that takes. Only a refusal that cannot come right stops.
      const giveUp = permanent;
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

/** The four languages the sales CRMs ask at a close. */
const CLOSE_LANGUAGES = ["English", "Malayalam", "Hindi/Urdu", "Tamil"];

/**
 * The language the student studies in, from the enrolment on the invoice — one of the CRMs' four, or "" for none.
 * Older enrolments were typed by hand ("MALAYALAM", "hindi", "Hindi / Urdu") and are matched to the four; "Not
 * specified" (a close from before the CRMs asked) and anything else is none.
 */
function closeLanguage(raw: unknown): string {
  const key = String(raw ?? "").toLowerCase().replace(/\s+/g, "");
  if (!key) return "";
  if (key === "hindi" || key === "urdu" || key === "urdu/hindi") return "Hindi/Urdu";
  return CLOSE_LANGUAGES.find((l) => l.toLowerCase().replace(/\s+/g, "") === key) ?? "";
}

async function enrolmentLanguage(invoiceId: unknown): Promise<string> {
  const invoice = await Invoice.findById(invoiceId).select("enrolment.language").lean<{ enrolment?: { language?: string } } | null>();
  return closeLanguage(invoice?.enrolment?.language);
}

/** The sales CRM that sold the enrolment on the invoice — read when sent, like the language. */
async function enrolmentSaleCrm(invoiceId: unknown): Promise<EnrolmentCrm | null> {
  const invoice = await Invoice.findById(invoiceId)
    .select("enrolment.crm external.source")
    .lean<{ enrolment?: { crm?: string }; external?: { source?: string } } | null>();
  return enrolmentCrm(invoice?.enrolment?.crm, invoice?.external?.source);
}

/**
 * Who closed the enrolment on the invoice: the sales CRM's rep, by their email there, as kept at the close. Read when
 * sent, like the language; none for an enrolment from before the rep's email was kept.
 */
async function enrolmentCloser(invoiceId: unknown, crm: EnrolmentCrm | null): Promise<{ email: string; name: string; crm: string } | null> {
  const invoice = await Invoice.findById(invoiceId)
    .select("enrolment.meetingByEmail enrolment.meetingBy")
    .lean<{ enrolment?: { meetingByEmail?: string; meetingBy?: string } } | null>();
  const email = invoice?.enrolment?.meetingByEmail?.trim().toLowerCase() ?? "";
  return email ? { email, name: invoice?.enrolment?.meetingBy?.trim() ?? "", crm: crm ?? "" } : null;
}

/*
 * One pass at a time in this process, whether the timer or a kick started it:
 * a slow LMS or Tetra Commission must not let a second pass start on the same
 * rows while one is still sending them. A kick that lands mid-pass asks for
 * one more, so what it was kicked for goes out now, not on the next tick.
 */
let started = false;
let running = false;
let again = false;

async function runPass(): Promise<void> {
  if (running) {
    again = true;
    return;
  }
  running = true;
  try {
    do {
      again = false;
      await drainLmsProvisions();
      await drainLmsExtraCourses();
      await drainLmsAccessUpdates();
      await drainCommissionStudents();
    } while (again);
  } catch (err) {
    logger.error({ err }, "LMS provisioning pass failed");
  } finally {
    running = false;
  }
}

/**
 * Deliver what was just queued — an approved enrolment, or a payment that
 * opens more of a course — now, in the background, instead of on the next
 * tick. Only in the process that runs the worker (RUN_SCHEDULERS): a second
 * process sending the same rows would be caught by the far side's
 * idempotency, but there is no reason to lean on it, and the worker's own
 * timer picks the row up within the minute. Never awaited, never throws.
 */
export function kickLmsProvisioning(): void {
  if (!started) return;
  setImmediate(() => void runPass());
}

export function startLmsProvisionWorker(): void {
  if (!lmsConfigured()) {
    logger.info("LMS provisioning is not configured — approvals will not create students");
    return;
  }
  logCommissionConfig();
  started = true;
  setTimeout(() => void runPass(), 10_000);
  setInterval(() => void runPass(), EVERY_MS);
  logger.info("LMS provisioning worker started");
}
