import { Queue, Worker, type ConnectionOptions } from "bullmq";
import { createConnection } from "net";
import { logger } from "../lib/logger";
import { env } from "../config/env";
import { hrmsClient } from "../lib/hrms-client";
import { logSync, syncDepartmentsFromHrms } from "../modules/payroll-mapping/department-sync";

/**
 * Finance's departments brought into line with HRMS every hour (the user, 2026-11-05: "update the department according
 * to HRMS also") — new ones made, renamed ones renamed, people moved with them (payroll-mapping/department-sync.ts).
 * Admin → Departments has the same as a button, for when an hour is too long.
 */

const QUEUE_NAME = "department-sync";
const SCHEDULE = "20 * * * *"; // twenty past every hour
const HOUR_MS = 60 * 60 * 1000;
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

async function runPass(): Promise<void> {
  logSync(await syncDepartmentsFromHrms());
}

/** In-process hourly timer when there is no Redis. */
function startFallbackScheduler(): void {
  const runSafely = async () => {
    try {
      await runPass();
    } catch (err) {
      logger.error({ err }, "Department sync fallback pass failed");
    }
  };
  setTimeout(runSafely, 60_000);
  fallbackTimer = setInterval(runSafely, HOUR_MS);
  logger.info("Department sync fallback scheduler started (no Redis — in-process hourly timer)");
}

export async function startDepartmentSyncWorker(): Promise<void> {
  // No HRMS linked: nothing to bring in.
  if (!hrmsClient.isConfigured()) return;

  if (!(await redisIsAvailable())) {
    startFallbackScheduler();
    return;
  }

  queue = new Queue(QUEUE_NAME, { connection });
  await queue.add("sync", {}, { repeat: { pattern: SCHEDULE }, jobId: "hourly-department-sync" });

  const worker = new Worker(QUEUE_NAME, runPass, { connection });
  worker.on("failed", (_job, err) => logger.error({ err }, "Department sync job failed"));
  worker.on("error", (err) => logger.warn({ err }, "Department sync worker connection issue"));

  logger.info("Department sync worker started (Redis/BullMQ, hourly)");
}

export function stopDepartmentSyncScheduler(): void {
  if (fallbackTimer) { clearInterval(fallbackTimer); fallbackTimer = null; }
}
