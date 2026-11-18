import { logger } from "../lib/logger";
import { retryQueuedEmails } from "../lib/email";

/**
 * Sends again the emails the mail server refused for now (2026-11-18: Gmail's "454 4.7.0 Too many login attempts"):
 * every minute, whatever in the mail outbox is due (lib/email.ts retryQueuedEmails). A plain timer, like the CS
 * Portal workers beside it; in the process that runs the timed jobs only (RUN_SCHEDULERS), so none goes twice.
 */
const EVERY_MS = 60_000;
let running = false;

async function runPass(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await retryQueuedEmails();
  } catch (err) {
    logger.error({ err }, "Trying emails again failed");
  } finally {
    running = false;
  }
}

export function startMailRetryWorker(): void {
  setTimeout(() => void runPass(), 20_000);
  setInterval(() => void runPass(), EVERY_MS);
  logger.info("Email retry worker started");
}
