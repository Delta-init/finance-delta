import crypto from "node:crypto";
import { env } from "../config/env";
import { AppError } from "./http";
import { logger } from "./logger";
import { buildCanonical } from "./signing";

/**
 * Signed client for the HRMS integration API.
 *
 * The other half of `hrms-backend/src/middleware/serviceAuth.ts`. Every request
 * carries a timestamp, a single-use nonce and an HMAC over
 *
 *   METHOD \n PATH_WITH_QUERY \n TIMESTAMP \n NONCE \n sha256(body)
 *
 * so that a captured request cannot be replayed and an altered one cannot be
 * passed off as ours. Keep the canonical string byte-identical to the HRMS side
 * — a mismatch here shows up as a blanket 401 with no hint as to which field
 * disagreed, because the server deliberately will not say.
 */

const TIMEOUT_MS = 20_000;

function assertConfigured(): { baseUrl: string; clientId: string; secret: string } {
  const baseUrl = env.HRMS_API_URL.replace(/\/+$/, "");
  if (!baseUrl || !env.HRMS_CLIENT_ID || !env.HRMS_INTEGRATION_SECRET) {
    throw new AppError(
      "VALIDATION_ERROR",
      "HRMS integration is not configured. Set HRMS_API_URL, HRMS_CLIENT_ID and HRMS_INTEGRATION_SECRET.",
    );
  }
  return { baseUrl, clientId: env.HRMS_CLIENT_ID, secret: env.HRMS_INTEGRATION_SECRET };
}

interface HrmsEnvelope<T> {
  success: boolean;
  message: string;
  data: T;
  pagination?: { total: number; page: number; limit: number; totalPages: number };
}

async function request<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
): Promise<HrmsEnvelope<T>> {
  const { baseUrl, clientId, secret } = assertConfigured();

  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== "") search.set(k, String(v));
  }
  const qs = search.toString();

  // Signed exactly as the server will see it in `req.originalUrl`: the API
  // prefix included, the query string included, nothing normalised away.
  const signedPath = `/api/v1/integrations${path}${qs ? `?${qs}` : ""}`;
  const rawBody = opts.body === undefined ? "" : JSON.stringify(opts.body);
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(16).toString("hex");
  const signature = crypto
    .createHmac("sha256", secret)
    .update(buildCanonical(method, signedPath, timestamp, nonce, rawBody))
    .digest("hex");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${baseUrl}${signedPath}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Delta-Client": clientId,
        "X-Delta-Timestamp": timestamp,
        "X-Delta-Nonce": nonce,
        "X-Delta-Signature": signature,
      },
      body: rawBody === "" ? undefined : rawBody,
      signal: controller.signal,
    });

    const text = await res.text();
    let parsed: HrmsEnvelope<T> | undefined;
    try {
      parsed = text ? (JSON.parse(text) as HrmsEnvelope<T>) : undefined;
    } catch {
      // Falls through to the error below with the raw text for diagnosis.
    }

    if (!res.ok || !parsed?.success) {
      const detail = parsed?.message ?? text.slice(0, 300);
      logger.warn(`HRMS ${method} ${signedPath} → ${res.status}: ${detail}`);
      if (res.status === 401) {
        throw new AppError(
          "FORBIDDEN",
          "HRMS rejected our credentials. Check HRMS_CLIENT_ID / HRMS_INTEGRATION_SECRET and that both servers' clocks are within 5 minutes.",
        );
      }
      if (res.status === 503) {
        throw new AppError("VALIDATION_ERROR", "The HRMS integration API is disabled on that server.");
      }
      throw new AppError("INTERNAL", `HRMS request failed (${res.status}): ${detail}`);
    }
    return parsed;
  } catch (err) {
    if (err instanceof AppError) throw err;
    if ((err as Error).name === "AbortError") {
      throw new AppError("INTERNAL", `HRMS did not respond within ${TIMEOUT_MS / 1000}s.`);
    }
    throw new AppError("INTERNAL", `Could not reach HRMS: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

export interface HrmsOrganization {
  id: string;
  name: string;
  code: string;
  currency: string;
  timeZone: string;
  status: string;
}

export interface HrmsDepartment {
  id: string;
  organizationId: string | null;
  name: string;
  code: string;
  status: string;
}

export interface HrmsEmployee {
  id: string;
  organizationId: string | null;
  employeeCode: string;
  name: string;
  email: string;
  departmentId: string | null;
  designation: string;
  employmentType: string;
  status: string;
  joiningDate: string | null;
  currency: string;
  hasBankDetails: boolean;
  updatedAt: string;
}


export interface HrmsHandoverLine {
  payslipId: string;
  employeeId: string;
  employeeCode: string;
  name: string;
  departmentId: string | null;
  departmentName: string;
  designation: string;
  grossPay: number;
  totalDeductions: number;
  netPay: number;
  earnings: Array<{ label: string; amount: number }>;
  deductions: Array<{ label: string; amount: number }>;
  status: string;
  paidAt: string | null;
  bank: { iban: string; accountNumber: string; bankName: string; nameInBank: string };
  payable: boolean;
}

export interface HrmsBatchSummary {
  month: string;
  status: string;
  currency: string;
  employeeCount: number;
  grossTotal: number;
  deductionTotal: number;
  netTotal: number;
  submittedAt: string | null;
  financeRunId: string;
}

export interface HrmsAdjustmentOutcome {
  externalId: string;
  employeeId: string;
  payslipId: string;
  label: string;
  kind: "payment" | "deduction";
  amount: number;
  /** What the month could actually take. Below `amount` when it could not afford it. */
  appliedAmount: number;
  outstanding: number;
  netBefore: number;
  netAfter: number;
  deferred: number;
}

export interface HrmsAdjustmentResult {
  month: string;
  applied: number;
  outcomes: HrmsAdjustmentOutcome[];
}

export interface HrmsPaymentResult {
  duplicate: boolean;
  message: string;
  month: string;
  status: string;
  paidCount: number;
  skipped?: number;
  outstanding?: number;
}

export interface HrmsBatch {
  month: string;
  organizationId: string;
  status: string;
  currency: string;
  submittedAt: string | null;
  financeRunId: string;
  lines: HrmsHandoverLine[];
  totals: {
    employeeCount: number; grossTotal: number; deductionTotal: number;
    netTotal: number; unpayable: number;
  };
  snapshot: { employeeCount: number; grossTotal: number; deductionTotal: number; netTotal: number };
}

export const hrmsClient = {
  isConfigured(): boolean {
    return Boolean(env.HRMS_API_URL && env.HRMS_CLIENT_ID && env.HRMS_INTEGRATION_SECRET);
  },

  async ping() {
    return (await request<{ service: string; time: string }>("GET", "/ping")).data;
  },

  async organizations(): Promise<HrmsOrganization[]> {
    return (await request<HrmsOrganization[]>("GET", "/directory/organizations")).data;
  },

  async departments(organizationId: string): Promise<HrmsDepartment[]> {
    return (await request<HrmsDepartment[]>("GET", "/directory/departments", { query: { organizationId } })).data;
  },

  async payrollBatches(organizationId: string, status?: string): Promise<HrmsBatchSummary[]> {
    return (await request<HrmsBatchSummary[]>("GET", "/payroll/batches", { query: { organizationId, status } })).data;
  },

  async payrollBatch(organizationId: string, month: string): Promise<HrmsBatch> {
    return (await request<HrmsBatch>("GET", `/payroll/batches/${month}`, { query: { organizationId } })).data;
  },

  /**
   * Push additions and deductions onto a month HR has handed over, and get back
   * what each one actually did to the payslip.
   *
   * Idempotent on each item's `externalId`, which is what makes a retry after a
   * timeout safe — the alternative is paying somebody twice because a response
   * was lost.
   */
  async applyAdjustments(
    organizationId: string,
    month: string,
    items: Array<{
      externalId: string; employeeId: string;
      kind: "payment" | "deduction"; label: string; amount: number; notes?: string;
    }>,
  ): Promise<HrmsAdjustmentResult> {
    return (
      await request<HrmsAdjustmentResult>("POST", `/payroll/batches/${month}/adjustments`, {
        query: { organizationId },
        body: { organizationId, items },
      })
    ).data;
  },

  async removeAdjustment(organizationId: string, month: string, externalId: string) {
    return (
      await request<{ externalId: string }>(
        "DELETE",
        `/payroll/batches/${month}/adjustments/${externalId}`,
        { query: { organizationId } },
      )
    ).data;
  },

  async approveBatch(organizationId: string, month: string, note?: string) {
    return (
      await request<{ month: string; status: string }>("POST", `/payroll/batches/${month}/approve`, {
        query: { organizationId },
        body: { organizationId, note },
      })
    ).data;
  },

  async returnBatch(organizationId: string, month: string, reason: string) {
    return (
      await request<{ month: string; status: string }>("POST", `/payroll/batches/${month}/return`, {
        query: { organizationId },
        body: { organizationId, reason },
      })
    ).data;
  },

  /**
   * Tell HRMS that money has left the bank.
   *
   * Idempotent on `paymentId`, and that matters more here than anywhere else:
   * by the time this is called the transfer has already happened, so a retry
   * after a lost response must be recognised rather than argued with.
   */
  async recordPayment(
    organizationId: string,
    month: string,
    input: {
      paymentId: string; paidOn: string; reference?: string; method?: string;
      lines: Array<{ payslipId: string; amount: number }>;
    },
  ): Promise<HrmsPaymentResult> {
    return (
      await request<HrmsPaymentResult>("POST", `/payroll/batches/${month}/payments`, {
        query: { organizationId },
        body: { organizationId, ...input },
      })
    ).data;
  },

  async reversePayment(organizationId: string, month: string, paymentId: string, reason: string) {
    return (
      await request<{ month: string; status: string; reversed: number }>(
        "POST",
        `/payroll/batches/${month}/payments/${paymentId}/reverse`,
        { query: { organizationId }, body: { organizationId, reason } },
      )
    ).data;
  },

  /** Take possession of a month. Idempotent on `financeRunId`. */
  async claimPayrollBatch(organizationId: string, month: string, financeRunId: string) {
    return (
      await request<{ month: string; status: string }>("POST", `/payroll/batches/${month}/claim`, {
        query: { organizationId },
        body: { organizationId, financeRunId },
      })
    ).data;
  },

  /**
   * The whole roster, paged through to the end.
   *
   * Bounded by `maxPages` rather than trusting the server's own count: a sync
   * that silently loops is worse than one that stops and says the roster is
   * larger than expected.
   */
  async allEmployees(organizationId: string, opts: { updatedSince?: string; includeInactive?: boolean } = {}) {
    const limit = 200;
    const maxPages = 50;
    const out: HrmsEmployee[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const res = await request<HrmsEmployee[]>("GET", "/directory/employees", {
        query: { organizationId, page, limit, updatedSince: opts.updatedSince, includeInactive: opts.includeInactive },
      });
      out.push(...res.data);
      const totalPages = res.pagination?.totalPages ?? 1;
      if (page >= totalPages) return out;
      if (page === maxPages) {
        throw new AppError("INTERNAL", `HRMS roster exceeded ${maxPages * limit} employees; sync aborted rather than truncated.`);
      }
    }
    return out;
  },
};
