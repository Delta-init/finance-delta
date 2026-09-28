import { env } from "../config/env";
import { logger } from "./logger";

/**
 * Client for Tetra Commission's student intake.
 *
 * The other half of `backend/src/finance/students.ts` in the commission
 * portal (Delta-init/tetracapitals). The same shared-secret header as the LMS
 * link, so the two outbound student links work — and fail — the same way.
 *
 * Never throws for being switched off: unset, the LMS provisioning carries on
 * exactly as before and nobody is sent.
 */

const TIMEOUT_MS = 20_000;

export function commissionConfigured(): boolean {
  return Boolean(env.COMMISSION_API_URL && env.COMMISSION_S2S_SECRET);
}

export interface CommissionStudentResult {
  /** Whether this call made the student. */
  created: boolean;
  /** Why not: "invoice" — sent before, still ours; "email" — somebody already there, left alone. */
  existing: "invoice" | "email" | null;
  studentId: string;
  studentCode: string;
  assignment: "assigned" | "open_pool";
  /** Their primary mentor there: the leader of the team they went to, or whoever has them already. */
  mentorName: string;
  /** The team this call gave them to; empty when it gave them to nobody. */
  teamName: string;
  detail: string;
}

/** Refused in a way that will not come right on its own — a bad secret, a malformed student. */
export class CommissionPermanentError extends Error {
  readonly permanent = true;
}

/**
 * Tetra Commission is up but not ready for this yet: its server is still on
 * code from before the route existed (404), or its side of the secret is not
 * set (503). Both come right when somebody deploys or configures it, so the
 * student waits for that rather than being given up on — finance switched on
 * first must not lose the students that arrive in between.
 */
export class CommissionNotReadyError extends Error {
  readonly notReady = true;
}

export async function sendStudentToCommission(input: {
  invoiceId: string;
  invoiceNumber?: string;
  email: string;
  name?: string;
  phone?: string;
  country?: string;
  course?: string;
  lmsUserId?: string;
}): Promise<CommissionStudentResult> {
  const baseUrl = env.COMMISSION_API_URL.replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/api/v1/integrations/finance/students`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-finance-secret": env.COMMISSION_S2S_SECRET },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => ({}))) as {
      data?: CommissionStudentResult;
      error?: { code?: string; message?: string } | string;
    };
    if (!res.ok) {
      const message =
        (typeof body.error === "object" ? body.error?.message : body.error) ?? `Tetra Commission refused with ${res.status}`;
      if (res.status === 404 || res.status === 503) throw new CommissionNotReadyError(message);
      // Any other 4xx is ours to fix and will not fix itself; 5xx and a timeout might.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) throw new CommissionPermanentError(message);
      throw new Error(message);
    }
    if (!body.data) throw new Error("Tetra Commission returned no result");
    return body.data;
  } finally {
    clearTimeout(timer);
  }
}

/** Said once at boot, so a silent link is visible without digging. */
export function logCommissionConfig(): void {
  if (commissionConfigured()) logger.info("Tetra Commission is configured — new LMS students are sent there");
  else logger.info("Tetra Commission is not configured — new LMS students are not sent there");
}
