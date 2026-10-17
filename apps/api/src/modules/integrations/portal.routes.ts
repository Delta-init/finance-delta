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

export default router;
