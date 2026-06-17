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
      await sendReminderEmail({ to: customerEmail, ...rest });
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
