import { logger } from "../lib/logger";
import { commissionConfigured } from "../lib/commission-client";
import { drainTetraDepositDecisions } from "../modules/tetra-deposit/tetra-deposit.service";

/**
 * Gets the accountants' decisions on Tetra Commission deposits back there.
 *
 * Each decision is sent the moment it is made, by the request that makes it;
 * this is the safety net for the ones that could not go then — Tetra
 * Commission down, or the request dying part-way — and keeps trying until they
 * arrive. A plain timer, like the LMS provisioning worker beside it.
 */

const EVERY_MS = 15_000;
let running = false;

async function runPass(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await drainTetraDepositDecisions();
  } catch (err) {
    logger.error({ err }, "Tetra Commission deposit decisions pass failed");
  } finally {
    running = false;
  }
}

export function startTetraDepositWorker(): void {
  if (!commissionConfigured()) {
    logger.info("Tetra Commission is not configured — its deposit requests are not taken here");
    return;
  }
  setTimeout(() => void runPass(), 10_000);
  setInterval(() => void runPass(), EVERY_MS);
  logger.info("Tetra Commission deposit decisions worker started");
}
