import { env } from "../config/env";
import { logger } from "./logger";

/**
 * Client for the LMS provisioning endpoint.
 *
 * The other half of `lms/backend/src/routes/integrations.routes.ts`. A shared
 * secret in a header rather than the signed canonical string the HRMS link
 * uses — that is what the LMS already accepts on its server-to-server routes,
 * and adding a second scheme there would be one more thing to keep in step
 * across two repositories.
 *
 * Never throws for being switched off. An installation with no LMS configured
 * approves invoices exactly as it did before, and says so once in the log
 * rather than failing an approval that has nothing to do with the LMS.
 */

const TIMEOUT_MS = 20_000;

export function lmsConfigured(): boolean {
  return Boolean(env.LMS_API_URL && env.LMS_S2S_SECRET);
}

export interface LmsProvisionResult {
  userId: string;
  created: boolean;
  alreadyProcessed: boolean;
  courseSlug: string;
  courseTitle: string;
  organizationSlug: string | null;
}

/**
 * Thrown when the LMS refuses in a way that will not come right on its own —
 * an unknown course slug, a malformed payload. The queue stops retrying these,
 * because the same request will fail the same way every minute until somebody
 * looks at it, and a queue busy doing that buries the ones that would work.
 */
export class LmsPermanentError extends Error {
  readonly permanent = true;
}

export async function provisionEnrolment(input: {
  email: string;
  name?: string;
  phone?: string;
  courseSlug: string;
  invoiceId: string;
  invoiceNumber?: string;
  /** Whole currency units, as the LMS records orders. */
  amount?: number;
}): Promise<LmsProvisionResult> {
  // The LMS mounts everything under /api/v1. Accepted with or without it, so a
  // base URL copied from a browser's address bar works either way rather than
  // producing /api/v1/api/v1/... and a 404 that says nothing useful.
  const baseUrl = env.LMS_API_URL.replace(/\/+$/, "").replace(/\/api\/v1$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${baseUrl}/api/v1/integrations/finance/enrolment`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-finance-secret": env.LMS_S2S_SECRET,
      },
      body: JSON.stringify(input),
      signal: controller.signal,
    });

    const body = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      data?: LmsProvisionResult;
      error?: { code?: string; message?: string };
    };

    if (!res.ok) {
      const message = body.error?.message ?? `LMS refused with ${res.status}`;
      // 4xx is our mistake and will not fix itself; 5xx and a timeout might.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        throw new LmsPermanentError(message);
      }
      throw new Error(message);
    }
    if (!body.data) throw new Error("LMS returned no result");
    return body.data;
  } finally {
    clearTimeout(timer);
  }
}

/** Said once at boot, so a silent integration is visible without digging. */
export function logLmsConfig(): void {
  if (lmsConfigured()) logger.info("LMS provisioning is configured");
  else logger.info("LMS provisioning is not configured — approvals will not create students");
}
