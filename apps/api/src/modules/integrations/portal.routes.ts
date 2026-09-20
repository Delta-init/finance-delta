import { Router, type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { env } from "../../config/env";
import { AppError, asyncHandler, ok } from "../../lib/http";
import { logger } from "../../lib/logger";
import { provisionFromPortal } from "./portal-provision.service";
import {
  listRolesForPortal,
  describeUserForPortal,
  setUserRoleFromPortal,
} from "./portal-directory.service";

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

export default router;
