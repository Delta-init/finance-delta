import { Queue, Worker, type ConnectionOptions } from "bullmq";
import { logger } from "../lib/logger";
import { sendReminderEmail } from "../lib/email";
import { env } from "../config/env";
import { createConnection } from "net";

const QUEUE_NAME = "invoice-reminders";

interface ReminderJob {
  invoiceId: string; orgId: string; orgName: string; footerText: string;
  customerEmail: string; customerName: string; invoiceNumber: string;
  totalFormatted: string; dueDate: string; intervalDays: number;
}

let reminderQueue: Queue<ReminderJob> | null = null;

/**
 * Whether this reminder should still go out.
 *
 * The job carries what was true when the invoice was sent — the number, the
 * total, the address — and it fires days or weeks later. Everything it carries
 * can have stopped being true by then: the invoice may have been paid, voided,
 * or deleted outright.
 *
 * Nothing cancels a queued reminder when any of that happens, and the worker
 * used to send whatever it was handed. So an invoice paid the day after it was
 * issued still produced "please arrange payment" at +1 day and again at +7 —
 * to a customer who had already paid. Chasing somebody for money they have
 * sent is worse than not chasing at all.
 *
 * Cancelling on payment was the other option, but it has to be right in four
 * places — payment, part payment, void, delete — and a reminder that slipped
 * through any of them would go out regardless. Asking at the moment of sending
 * cannot be forgotten, and it covers the reminders already queued.
 */
export async function stillOwed(invoiceId: string, orgId: string): Promise<{ ok: boolean; why?: string }> {
  const { Invoice } = await import("../modules/invoice/invoice.model");
  const doc = await Invoice.findOne({ _id: invoiceId, organizationId: orgId })
    .select("status balanceMinor")
    .lean<{ status?: string; balanceMinor?: number } | null>();

  if (!doc) return { ok: false, why: "invoice no longer exists" };
  if (doc.status === "void") return { ok: false, why: "invoice was voided" };
  if ((doc.balanceMinor ?? 0) <= 0) return { ok: false, why: "invoice is settled" };
  return { ok: true };
}

function redisIsAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const url = new URL(env.REDIS_URL.startsWith("redis://") ? env.REDIS_URL : `redis://${env.REDIS_URL}`);
    const sock = createConnection({ host: url.hostname, port: Number(url.port) || 6379 });
    const done = (ok: boolean) => { sock.destroy(); resolve(ok); };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(2000, () => done(false));
  });
}

const connection: ConnectionOptions = { url: env.REDIS_URL };

export async function startReminderWorker(): Promise<void> {
  if (!(await redisIsAvailable())) {
    logger.warn("Reminder worker disabled — Redis unavailable");
    return;
  }

  reminderQueue = new Queue<ReminderJob>(QUEUE_NAME, { connection });
  const worker = new Worker<ReminderJob>(
    QUEUE_NAME,
    async (job) => {
      const { customerEmail, ...rest } = job.data;

      const state = await stillOwed(job.data.invoiceId, job.data.orgId);
      if (!state.ok) {
        logger.info(
          { invoiceId: job.data.invoiceId, interval: job.data.intervalDays, reason: state.why },
          "Reminder dropped",
        );
        return;
      }

      const { error } = await sendReminderEmail({ to: customerEmail, ...rest });
      // Said plainly either way: a reminder that did not go is the kind of
      // thing that is only noticed when somebody asks why nobody was chased.
      if (error) {
        logger.warn({ invoiceId: job.data.invoiceId, interval: job.data.intervalDays, error }, "Reminder not sent");
        throw new Error(error);
      }
      logger.info({ invoiceId: job.data.invoiceId, interval: job.data.intervalDays }, "Reminder sent");
    },
    { connection },
  );

  worker.on("failed", (_j, err) => logger.error({ err }, "Reminder job failed"));
  worker.on("error", (err) => logger.warn({ err }, "Reminder worker connection issue"));

  logger.info("Invoice reminder worker started");
}

export async function scheduleReminders(opts: {
  invoiceId: string; orgId: string; orgName: string; footerText: string;
  customerEmail: string; customerName: string; invoiceNumber: string;
  totalFormatted: string; dueDate: string; intervals: number[];
}): Promise<void> {
  if (!reminderQueue) return;
  const dueMs = new Date(opts.dueDate).getTime();
  for (const days of opts.intervals) {
    const fireAt = dueMs + days * 24 * 60 * 60 * 1000;
    const delay = fireAt - Date.now();
    if (delay <= 0) continue;
    await reminderQueue.add(
      "reminder",
      { ...opts, intervalDays: days },
      { delay, jobId: `reminder-${opts.invoiceId}-${days}`, removeOnComplete: true },
    ).catch(() => {});
  }
}

export async function cancelReminders(invoiceId: string, intervals: number[]): Promise<void> {
  if (!reminderQueue) return;
  for (const days of intervals) {
    const job = await reminderQueue.getJob(`reminder-${invoiceId}-${days}`).catch(() => null);
    await job?.remove().catch(() => {});
  }
}
