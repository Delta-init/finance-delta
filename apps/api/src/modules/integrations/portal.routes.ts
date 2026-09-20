import { Router, type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { env } from "../../config/env";
import { AppError, asyncHandler, ok } from "../../lib/http";
import { logger } from "../../lib/logger";
import { provisionFromPortal } from "./portal-provision.service";

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

export default router;
