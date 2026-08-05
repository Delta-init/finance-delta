import type { Request } from "express";
import { asyncHandler, ok, AppError } from "../../lib/http";
import * as svc from "./reports.service";

const org = (req: Request) => req.auth!.organizationId;

/** Reads a date query param, defaulting when absent and rejecting garbage with
 *  a clean 400 instead of letting it reach (and crash) the DB layer. */
function dateParam(req: Request, key: string, fallback: string): string {
  const v = req.query[key] as string | undefined;
  if (v === undefined || v === "") return fallback;
  if (Number.isNaN(new Date(v).getTime())) {
    throw new AppError("VALIDATION_ERROR", `Invalid date for '${key}' (expected YYYY-MM-DD)`);
  }
  return v;
}

const INVOICE_SUMMARY_GROUPS = ["salesperson", "customer", "tag", "department"] as const;
type InvoiceSummaryGroupBy = (typeof INVOICE_SUMMARY_GROUPS)[number];

function groupByParam(req: Request): InvoiceSummaryGroupBy {
  const v = (req.query.groupBy as string | undefined) ?? "customer";
  if (!INVOICE_SUMMARY_GROUPS.includes(v as InvoiceSummaryGroupBy)) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Invalid groupBy '${v}' (expected one of ${INVOICE_SUMMARY_GROUPS.join(", ")})`,
    );
  }
  return v as InvoiceSummaryGroupBy;
}

/** Optional 24-hex ObjectId query param; rejects malformed ids with 400. */
function objectIdParam(req: Request, key: string): string | undefined {
  const v = req.query[key] as string | undefined;
  if (!v) return undefined;
  if (!/^[a-f0-9]{24}$/i.test(v)) {
    throw new AppError("VALIDATION_ERROR", `Invalid ${key}`);
  }
  return v;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function monthStartStr(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

// ── 8.1 Receivables ───────────────────────────────────────────────────────────

export const receivedPayments = asyncHandler(async (req, res) => {
  const from = dateParam(req, "from", monthStartStr());
  const to = dateParam(req, "to", todayStr());
  ok(res, await svc.getReceivedPayments(org(req), from, to));
});

export const agedReceivables = asyncHandler(async (req, res) => {
  ok(res, await svc.getAgedReceivables(org(req)));
});

export const invoiceSummary = asyncHandler(async (req, res) => {
  const from = dateParam(req, "from", monthStartStr());
  const to = dateParam(req, "to", todayStr());
  const groupBy = groupByParam(req);
  ok(res, await svc.getInvoiceSummary(org(req), from, to, groupBy));
});

export const dailyReport = asyncHandler(async (req, res) => {
  const from = dateParam(req, "from", monthStartStr());
  const to = dateParam(req, "to", todayStr());
  const departmentId = objectIdParam(req, "departmentId");
  ok(res, await svc.getDailyReport(org(req), from, to, departmentId));
});

// ── 8.2 Payables ──────────────────────────────────────────────────────────────

export const madePayments = asyncHandler(async (req, res) => {
  const from = dateParam(req, "from", monthStartStr());
  const to = dateParam(req, "to", todayStr());
  ok(res, await svc.getMadePayments(org(req), from, to));
});

export const agedPayables = asyncHandler(async (req, res) => {
  ok(res, await svc.getAgedPayables(org(req)));
});

// ── 8.3 P&L ──────────────────────────────────────────────────────────────────

export const profitLoss = asyncHandler(async (req, res) => {
  const now = new Date();
  const from = dateParam(req, "from", `${now.getFullYear()}-01-01`);
  const to = dateParam(req, "to", todayStr());
  ok(res, await svc.getProfitLoss(org(req), from, to));
});

// ── 8.4 Balance Sheet ─────────────────────────────────────────────────────────

export const balanceSheet = asyncHandler(async (req, res) => {
  const asOf = dateParam(req, "asOf", todayStr());
  ok(res, await svc.getBalanceSheet(org(req), asOf));
});

// ── 8.5 Cash Flow ─────────────────────────────────────────────────────────────

export const cashFlow = asyncHandler(async (req, res) => {
  const now = new Date();
  const from = dateParam(req, "from", `${now.getFullYear()}-01-01`);
  const to = dateParam(req, "to", todayStr());
  ok(res, await svc.getCashFlow(org(req), from, to));
});

// ── 8.6 Tax ───────────────────────────────────────────────────────────────────

export const vatReport = asyncHandler(async (req, res) => {
  const now = new Date();
  const from = dateParam(req, "from", `${now.getFullYear()}-01-01`);
  const to = dateParam(req, "to", todayStr());
  ok(res, await svc.getVATReport(org(req), from, to));
});

// ── 8.7 Other ─────────────────────────────────────────────────────────────────

export const salesByItem = asyncHandler(async (req, res) => {
  const now = new Date();
  const from = dateParam(req, "from", `${now.getFullYear()}-01-01`);
  const to = dateParam(req, "to", todayStr());
  ok(res, await svc.getSalesByItem(org(req), from, to));
});

export const expenseByCategory = asyncHandler(async (req, res) => {
  const now = new Date();
  const from = dateParam(req, "from", `${now.getFullYear()}-01-01`);
  const to = dateParam(req, "to", todayStr());
  ok(res, await svc.getExpenseByCategory(org(req), from, to));
});

export const customerStatement = asyncHandler(async (req, res) => {
  const now = new Date();
  const from = dateParam(req, "from", `${now.getFullYear()}-01-01`);
  const to = dateParam(req, "to", todayStr());
  ok(res, await svc.getCustomerStatement(org(req), req.params.customerId!, from, to));
});
