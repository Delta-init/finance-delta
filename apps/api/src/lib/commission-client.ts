import { env } from "../config/env";
import { logger } from "./logger";
import type { EnrolmentFeeSummary } from "./lms-client";

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
  /** The language they study in, as the sales CRM asked it at the close: English, Malayalam, Hindi/Urdu or Tamil. */
  language?: string;
  lmsUserId?: string;
  /**
   * What the enrolment was at approval: fee, paid, balance, bonus and the
   * receipt. For the mentors' information only — the bonus here is what the
   * counsellor promised at the close, not a BONUS request, and creates none.
   */
  feeSummary?: EnrolmentFeeSummary;
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

/* ── Decisions on the deposit requests Tetra Commission sent for approval ── */

export interface CommissionFundingDecision {
  /** Tetra Commission's own id for the request. */
  fundingId: string;
  /** Ours. */
  financeId: string;
  decision: "approved" | "rejected";
  amountMinor?: number;
  transactionId?: string;
  paymentMethod?: string;
  mt5Login?: string;
  note?: string;
  reason?: string;
  decidedBy: { name: string; email: string };
  decidedAt: string;
}

export interface CommissionFundingDecisionResult {
  fundingId: string;
  status: string;
  amountUsd: number;
  transactionId: string;
  /** It had this decision already — a repeat. */
  already: boolean;
  credited: number;
  levelUpgraded: boolean;
}

/**
 * Tetra Commission will not take this decision, and sending it again will not
 * change that: the request is gone (410), decided there already, not sent to
 * us, or approved under a transaction ID another request has (409), or the
 * decision is malformed (400/422). `code` says which.
 */
export class CommissionRefusedError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
  }
}

/**
 * Send an accountant's decision on a deposit request back to Tetra Commission
 * (backend/src/finance/funding.ts there), on the same secret as the students.
 *
 * Anything but a refusal is thrown as a plain Error and waited out — a
 * decision is never dropped because Tetra Commission was down, not yet
 * deployed, or holding a different secret for a while.
 */
export async function sendFundingDecisionToCommission(input: CommissionFundingDecision): Promise<CommissionFundingDecisionResult> {
  const baseUrl = env.COMMISSION_API_URL.replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/api/v1/integrations/finance/funding-decisions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-finance-secret": env.COMMISSION_S2S_SECRET },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => ({}))) as {
      data?: CommissionFundingDecisionResult;
      error?: { code?: string; message?: string } | string;
    };
    if (!res.ok) {
      const code = typeof body.error === "object" ? body.error?.code ?? "" : "";
      const message =
        (typeof body.error === "object" ? body.error?.message : body.error) ?? `Tetra Commission refused with ${res.status}`;
      if ([400, 409, 410, 422].includes(res.status)) throw new CommissionRefusedError(message, res.status, code);
      throw new Error(message);
    }
    if (!body.data) throw new Error("Tetra Commission returned no result");
    return body.data;
  } catch (err) {
    if ((err as Error).name === "AbortError") throw new Error("Tetra Commission did not answer in time");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Said once at boot, so a silent link is visible without digging. */
export function logCommissionConfig(): void {
  if (commissionConfigured()) logger.info("Tetra Commission is configured — new LMS students are sent there");
  else logger.info("Tetra Commission is not configured — new LMS students are not sent there");
}
