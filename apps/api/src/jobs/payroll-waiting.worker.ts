import { Queue, Worker, type ConnectionOptions } from "bullmq";
import { createConnection } from "net";
import { logger } from "../lib/logger";
import { env } from "../config/env";
import { hrmsClient } from "../lib/hrms-client";
import { PayrollOrgLink } from "../modules/payroll-mapping/org-link.model";
import { PayrollRun } from "../modules/payroll/payroll-run.model";
import { notifyPayrollWaiting } from "../modules/payroll/notify.service";

/**
 * Tells accounts that HR has handed a payroll over.
 *
 * HRMS cannot send this itself — it has no addresses for the finance side and
 * knows nothing about who here is allowed to act on a payroll. Finance finds
 * out by asking, which is what this does: for every linked organization, which
 * submitted months have not been imported yet.
 *
 * Daily rather than hourly. A handover is a monthly event that nobody acts on
 * within the hour, and a mail arriving every hour about the same waiting month
 * stops being read — which is worse than not sending it.
 */

const QUEUE_NAME = "payroll-waiting";
const SCHEDULE = "0 9 * * *"; // 09:00, once the working day has started
const DAY_MS = 24 * 60 * 60 * 1000;
const connection: ConnectionOptions = { url: env.REDIS_URL };

let queue: Queue | null = null;
let fallbackTimer: ReturnType<typeof setInterval> | null = null;

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

export async function checkPayrollWaiting(): Promise<number> {
  const links = await PayrollOrgLink.find({ isActive: true }).lean();
  if (!links.length) return 0;

  // Grouped by finance organization, so somebody with several HRMS entities
  // feeding one book gets a single mail listing all of them rather than one
  // mail per entity.
  const byOrg = new Map<
    string,
    Array<{ period: string; hrmsOrgName: string; employeeCount: number; netTotal: number; currency: string }>
  >();

  for (const link of links) {
    const orgId = String(link.organizationId);
    let batches: Awaited<ReturnType<typeof hrmsClient.payrollBatches>>;
    try {
      batches = await hrmsClient.payrollBatches(link.hrmsOrgId, "submitted");
    } catch (err) {
      // One unreachable HRMS must not stop the others being reported.
      logger.warn(`Payroll waiting check: could not read ${link.hrmsOrgName}: ${(err as Error).message}`);
      continue;
    }
    if (!batches.length) continue;

    const imported = await PayrollRun.find({
      organizationId: link.organizationId,
      hrmsOrgId: link.hrmsOrgId,
      period: { $in: batches.map((b) => b.month) },
    })
      .select("period")
      .lean();
    const importedPeriods = new Set(imported.map((r) => r.period));

    for (const b of batches) {
      if (importedPeriods.has(b.month)) continue;
      if (!byOrg.has(orgId)) byOrg.set(orgId, []);
      byOrg.get(orgId)!.push({
        period: b.month,
        hrmsOrgName: link.hrmsOrgName,
        employeeCount: b.employeeCount,
        netTotal: b.netTotal,
        currency: b.currency,
      });
    }
  }

  for (const [orgId, batches] of byOrg) await notifyPayrollWaiting(orgId, batches);
  return [...byOrg.values()].reduce((a, b) => a + b.length, 0);
}

/** In-process daily timer when there is no Redis. Per API process, like the others. */
function startFallbackScheduler(): void {
  const runSafely = async () => {
    try {
      await checkPayrollWaiting();
    } catch (err) {
      logger.error({ err }, "Payroll waiting fallback pass failed");
    }
  };
  setTimeout(runSafely, 15_000);
  fallbackTimer = setInterval(runSafely, DAY_MS);
  logger.info("Payroll waiting fallback scheduler started (no Redis — in-process daily timer)");
}

export async function startPayrollWaitingWorker(): Promise<void> {
  // An organization that has not linked HRMS is simply not using the handover;
  // there is nothing to poll and nothing worth warning about.
  if (!hrmsClient.isConfigured()) return;

  if (!(await redisIsAvailable())) {
    startFallbackScheduler();
    return;
  }

  queue = new Queue(QUEUE_NAME, { connection });
  await queue.add("check", {}, { repeat: { pattern: SCHEDULE }, jobId: "daily-payroll-waiting-check" });

  const worker = new Worker(QUEUE_NAME, checkPayrollWaiting, { connection });
  worker.on("failed", (_job, err) => logger.error({ err }, "Payroll waiting job failed"));
  worker.on("error", (err) => logger.warn({ err }, "Payroll waiting worker connection issue"));

  logger.info("Payroll waiting worker started (Redis/BullMQ, daily at 09:00)");
}

export function stopPayrollWaitingScheduler(): void {
  if (fallbackTimer) { clearInterval(fallbackTimer); fallbackTimer = null; }
}
