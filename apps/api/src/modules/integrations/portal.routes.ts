import { Router, type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { env } from "../../config/env";
import { AppError, asyncHandler, ok } from "../../lib/http";
import { logger } from "../../lib/logger";
import { provisionFromPortal } from "./portal-provision.service";
import {
  listRolesForPortal,
  describeUserForPortal,
  describeManyForPortal,
  setUserRoleFromPortal,
} from "./portal-directory.service";
import { pendingForPortal } from "./portal-pending.service";
import { financeWatchForPortal } from "./portal-watch.service";
import { financeReportForPortal } from "./portal-report.service";
import { oldBooksPaymentsSince } from "./old-books-payments.service";
import { paymentNumbersFor } from "./payment-numbers.service";
import { agingReportForPortal, commissionReportForPortal, vatReportForPortal, expensesReportForPortal, payrollReportForPortal, financeOverviewForPortal, organizationsForPortal, revenueReportForPortal } from "./portal-finance-reports.service";

const router = Router();

/**
 * Server-to-server, from the Root portal only.
 *
 * Not reachable by a browser and carrying no session: the caller proves itself
 * with a shared secret, compared in constant time so the comparison itself
 * says nothing about how close a wrong guess was.
 */
function portalOnly(req: Request, res: Response, next: NextFunction): void {
  if (!env.ROOT_ERP_SECRET) {
    res.status(503).json({
      error: { code: "NOT_CONFIGURED", message: "Provisioning from the portal is not configured" },
    });
    return;
  }
  const presented = req.headers["x-portal-secret"];
  if (typeof presented !== "string") {
    res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Bad secret" } });
    return;
  }
  const a = Buffer.from(presented);
  const b = Buffer.from(env.ROOT_ERP_SECRET);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    logger.warn({ path: req.path }, "Portal provisioning: bad secret");
    res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Bad secret" } });
    return;
  }
  next();
}

router.use(portalOnly);

router.post(
  "/provision-user",
  asyncHandler(async (req: Request, res: Response) => {
    const { email, name, role, remoteOrgId } = (req.body ?? {}) as Record<string, string>;
    if (!email || !role) throw new AppError("VALIDATION_ERROR", "email and role are required");

    const result = await provisionFromPortal({ email, name: name ?? "", role, remoteOrgId });
    logger.info({ email, role, created: result.created }, "Portal provisioned an account");
    ok(res, result);
  }),
);

/**
 * What this organization's roles are, and what each one permits.
 *
 * The portal used to make an administrator type a role key into a box and
 * only told them it was wrong when provisioning failed. Now it can ask.
 */
router.get(
  "/roles",
  asyncHandler(async (req: Request, res: Response) => {
    const remoteOrgId = typeof req.query.remoteOrgId === "string" ? req.query.remoteOrgId : undefined;
    ok(res, await listRolesForPortal(remoteOrgId));
  }),
);

/** What one account actually holds here — the portal's check against drift. */
router.get(
  "/user",
  asyncHandler(async (req: Request, res: Response) => {
    const email = typeof req.query.email === "string" ? req.query.email : "";
    if (!email) throw new AppError("VALIDATION_ERROR", "email is required");
    const remoteOrgId = typeof req.query.remoteOrgId === "string" ? req.query.remoteOrgId : undefined;
    ok(res, await describeUserForPortal({ email, remoteOrgId }));
  }),
);

/** Change an existing membership's role or status. Creates nothing. */
router.post(
  "/set-user-role",
  asyncHandler(async (req: Request, res: Response) => {
    const { email, role, status, remoteOrgId } = (req.body ?? {}) as Record<string, string>;
    if (!email) throw new AppError("VALIDATION_ERROR", "email is required");

    const result = await setUserRoleFromPortal({ email, role, status, remoteOrgId });
    logger.info({ email, role, status }, "Portal changed an account's role");
    ok(res, result);
  }),
);

/**
 * The same question as /user, asked about many people at once.
 *
 * POST rather than GET because a page of addresses does not belong in a query
 * string, where every proxy in front of this would log it.
 */
router.post(
  "/accounts",
  asyncHandler(async (req: Request, res: Response) => {
    const { emails, remoteOrgId } = (req.body ?? {}) as { emails?: unknown; remoteOrgId?: string };
    ok(res, await describeManyForPortal({ emails, remoteOrgId }));
  }),
);

/**
 * What is waiting in finance, and on whom — the Root portal's Pending page.
 * Every organization's sidebar counts added up; see pendingForPortal.
 */
router.get(
  "/pending",
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ success: true, data: await pendingForPortal() });
  }),
);

/**
 * Approvals waiting (and the ones past 30 minutes) and entries typed with an
 * old date — the Root portal's Pending → Finance tab; see financeWatchForPortal.
 */
router.get(
  "/finance-watch",
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ success: true, data: await financeWatchForPortal() });
  }),
);

/**
 * One organization's expenses, approvals decided, invoices and budget over a
 * period — the Root portal's Reports → Finance tab; see financeReportForPortal.
 */
router.get(
  "/finance-report",
  asyncHandler(async (req: Request, res: Response) => {
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    const data = await financeReportForPortal({ org: str(req.query.org), from: str(req.query.from), to: str(req.query.to) });
    if (typeof data === "string") throw new AppError("VALIDATION_ERROR", data);
    res.json({ success: true, data });
  }),
);

/**
 * The old books' invoices with money paid on or after `from` (YYYY-MM-DD) — the Root portal's Manager TV line for
 * the money no CRM counts (2026-11-25). Root reaches finance this way with what it already has (FINANCE_HQ_API_URL,
 * FINANCE_HQ_SSO_SECRET); the CRMs ask the same list at /integrations/old-books/payments. Read-only.
 */
router.get(
  "/old-books/payments",
  asyncHandler(async (req: Request, res: Response) => {
    const from = typeof req.query.from === "string" ? req.query.from : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !Number.isFinite(Date.parse(from))) throw new AppError("VALIDATION_ERROR", "from is YYYY-MM-DD");
    res.json({ success: true, data: await oldBooksPaymentsSince(from) });
  }),
);

/**
 * POST /service/payment-numbers { invoiceNumbers, externalIds? } — each invoice's payments with their tax invoice and receipt
 * numbers (2026-11-25): the Root Manager TV export puts the TI beside each payment. Read-only; at most 2,000.
 */
router.post(
  "/payment-numbers",
  asyncHandler(async (req: Request, res: Response) => {
    const list = Array.isArray(req.body?.invoiceNumbers) ? req.body.invoiceNumbers : null;
    if (!list) throw new AppError("VALIDATION_ERROR", "invoiceNumbers is a list");
    const ids = Array.isArray(req.body?.externalIds) ? req.body.externalIds.map(String) : [];
    res.json({ success: true, data: await paymentNumbersFor(list.map(String), ids) });
  }),
);

/*
 * The Root portal's Report Org → Finance and revenue (2026-11-26): the organizations here, one organization's headline
 * figures for a period, the Revenue report (invoiced or collected, grouped and filtered) and the Expense report (by
 * expense or paid date, grouped and filtered) — each from the functions finance's own pages use; see
 * portal-finance-reports.service. Read-only, one organization per call.
 */
router.get(
  "/reports/organizations",
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ success: true, data: await organizationsForPortal() });
  }),
);

router.get(
  "/reports/overview",
  asyncHandler(async (req: Request, res: Response) => {
    const data = await financeOverviewForPortal(req.query as Record<string, unknown>);
    if (typeof data === "string") throw new AppError("VALIDATION_ERROR", data);
    res.json({ success: true, data });
  }),
);

router.get(
  "/reports/revenue",
  asyncHandler(async (req: Request, res: Response) => {
    const data = await revenueReportForPortal(req.query as Record<string, unknown>);
    if (typeof data === "string") throw new AppError("VALIDATION_ERROR", data);
    res.json({ success: true, data });
  }),
);

router.get(
  "/reports/expenses",
  asyncHandler(async (req: Request, res: Response) => {
    const data = await expensesReportForPortal(req.query as Record<string, unknown>);
    if (typeof data === "string") throw new AppError("VALIDATION_ERROR", data);
    res.json({ success: true, data });
  }),
);

/** What is still owed on open invoices (kind=receivables) or open bills (kind=payables), as of now (2026-11-27). Read-only. */
router.get(
  "/reports/aging",
  asyncHandler(async (req: Request, res: Response) => {
    const data = await agingReportForPortal(req.query as Record<string, unknown>);
    if (typeof data === "string") throw new AppError("VALIDATION_ERROR", data);
    res.json({ success: true, data });
  }),
);

/** Commission finance approved and paid, and payroll runs — each person's pay or the payments made (2026-11-27). Read-only. */
/** …and the rows behind the VAT position and the income in "Income less expenses" (2026-11-27). Read-only. */
for (const [path, report] of [["commission", commissionReportForPortal], ["payroll", payrollReportForPortal], ["vat", vatReportForPortal]] as const) {
  router.get(
    `/reports/${path}`,
    asyncHandler(async (req: Request, res: Response) => {
      const data = await report(req.query as Record<string, unknown>);
      if (typeof data === "string") throw new AppError("VALIDATION_ERROR", data);
      res.json({ success: true, data });
    }),
  );
}

export default router;
