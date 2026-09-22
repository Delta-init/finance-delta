import { Queue, Worker, type ConnectionOptions } from "bullmq";
import { createConnection } from "node:net";
import { env } from "../config/env";
import { logger } from "../lib/logger";
import { sendNotice } from "../lib/email";
import { hrmsClient } from "../lib/hrms-client";
import { PayrollOrgLink } from "../modules/payroll-mapping/org-link.model";
import { payrollRecipients } from "../modules/payroll/notify.service";

/**
 * Purchase requests waiting on finance, found by asking.
 *
 * HRMS has no way to reach in here and nothing to push to, so the same
 * arrangement the payroll handover uses applies: once a day, for every linked
 * organisation, ask what HR has approved and tell whoever may decide it. A
 * request sitting unseen for a week is the failure this exists to prevent.
 */
const QUEUE_NAME = "procurement-waiting";
/** An hour after the payroll check, so two notices do not arrive together. */
const SCHEDULE = "0 10 * * *";
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

export async function checkProcurementWaiting(): Promise<number> {
  const links = await PayrollOrgLink.find({ isActive: true }).lean();
  if (!links.length) return 0;

  // Grouped by finance organization: somebody with several HRMS entities
  // feeding one book gets one mail, not one per entity.
  const byOrg = new Map<string, Array<{ item: string; quantity: number; cost: string; from: string; neededBy?: string | null }>>();

  for (const link of links) {
    const orgId = String(link.organizationId);
    try {
      const rows = await hrmsClient.procurementRequests(link.hrmsOrgId);
      for (const r of rows) {
        if (!byOrg.has(orgId)) byOrg.set(orgId, []);
        byOrg.get(orgId)!.push({
          item: r.item,
          quantity: r.quantity,
          cost: `${r.currency} ${(r.estimatedCost || 0).toLocaleString("en-US")}`,
          from: link.hrmsOrgName,
          neededBy: r.neededBy,
        });
      }
    } catch (err) {
      // One unreachable HRMS must not stop the others being reported.
      logger.warn(`Procurement waiting check: could not read ${link.hrmsOrgName}: ${(err as Error).message}`);
    }
  }

  for (const [orgId, rows] of byOrg) {
    try {
      const to = await payrollRecipients(orgId, "po:create");
      if (!to.length) continue;
      await sendNotice({
        to,
        subject: rows.length === 1 ? "A purchase request is waiting for approval" : `${rows.length} purchase requests are waiting for approval`,
        title: "HR has approved a purchase request",
        lines: rows.map(
          (r) => `<strong>${r.quantity} × ${r.item}</strong> — ${r.cost}, from ${r.from}` +
            (r.neededBy ? `, needed by ${String(r.neededBy).slice(0, 10)}` : ""),
        ),
        actionLabel: "Review requests",
        actionUrl: `${env.WEB_ORIGIN.split(",")[0]?.trim() ?? ""}/procurement`,
      });
    } catch (err) {
      logger.error({ err }, "Procurement waiting notice failed");
    }
  }
  return [...byOrg.values()].reduce((a, b) => a + b.length, 0);
}

/** In-process daily timer when there is no Redis. Per API process, like the others. */
function startFallbackScheduler(): void {
  const runSafely = async () => {
    try {
      await checkProcurementWaiting();
    } catch (err) {
      logger.error({ err }, "Procurement waiting fallback pass failed");
    }
  };
  setTimeout(runSafely, 20_000);
  fallbackTimer = setInterval(runSafely, DAY_MS);
  logger.info("Procurement waiting fallback scheduler started (no Redis — in-process daily timer)");
}

export async function startProcurementWaitingWorker(): Promise<void> {
  if (!hrmsClient.isConfigured()) return;

  if (!(await redisIsAvailable())) {
    startFallbackScheduler();
    return;
  }

  queue = new Queue(QUEUE_NAME, { connection });
  await queue.add("check", {}, { repeat: { pattern: SCHEDULE }, jobId: "daily-procurement-waiting-check" });

  const worker = new Worker(QUEUE_NAME, checkProcurementWaiting, { connection });
  worker.on("failed", (_job, err) => logger.error({ err }, "Procurement waiting job failed"));
  worker.on("error", (err) => logger.warn({ err }, "Procurement waiting worker connection issue"));

  logger.info("Procurement waiting worker started (Redis/BullMQ, daily at 10:00)");
}

export function stopProcurementWaitingScheduler(): void {
  if (fallbackTimer) { clearInterval(fallbackTimer); fallbackTimer = null; }
}
