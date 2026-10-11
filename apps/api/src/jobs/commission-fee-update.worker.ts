import { logger } from "../lib/logger";
import { commissionConfigured } from "../lib/commission-client";
import { drainFeeUpdates, onFeeUpdateQueued } from "../modules/integrations/commission-fee-update.service";

/**
 * Gets enrolments' fee updates to Tetra Commission (the user, 2026-10-11).
 *
 * Each is sent straight after the change that queued it, in the background;
 * this timer is the safety net that retries whatever could not go then —
 * Tetra Commission down, not deployed yet, or the process dying part-way. A
 * plain timer, like the deposit decisions worker beside it: no Redis.
 */

const EVERY_MS = 15_000;
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
      await drainFeeUpdates();
    } while (again);
  } catch (err) {
    logger.error({ err }, "Tetra Commission fee updates pass failed");
  } finally {
    running = false;
  }
}

export function startCommissionFeeUpdateWorker(): void {
  if (!commissionConfigured()) {
    logger.info("Tetra Commission is not configured — fee updates are not sent");
    return;
  }
  started = true;
  // Woken by each change, in this process only (RUN_SCHEDULERS); elsewhere the row waits for this timer.
  onFeeUpdateQueued(() => {
    if (started) setImmediate(() => void runPass());
  });
  setTimeout(() => void runPass(), 10_000);
  setInterval(() => void runPass(), EVERY_MS);
  logger.info("Tetra Commission fee updates worker started");
}
