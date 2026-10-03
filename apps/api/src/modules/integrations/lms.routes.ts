import { Router, type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { env } from "../../config/env";
import { AppError, asyncHandler, ok } from "../../lib/http";
import { logger } from "../../lib/logger";
import { Customer } from "../customer/customer.model";
import { Organization } from "../organization/organization.model";

const router = Router();

/**
 * Server-to-server, from the Delta LMS only.
 *
 * The LMS proves itself with the secret finance already uses to call it
 * (LMS_S2S_SECRET here, FINANCE_S2S_SECRET there), compared in constant time.
 * One secret for the pair, both ways: whoever holds it can already enrol
 * students in the LMS as finance, far more than anything here lets them do.
 */
function lmsOnly(req: Request, res: Response, next: NextFunction): void {
  if (!env.LMS_S2S_SECRET) {
    res.status(503).json({
      error: { code: "NOT_CONFIGURED", message: "The LMS link is not configured on this server" },
    });
    return;
  }
  const presented = req.headers["x-lms-secret"];
  if (typeof presented !== "string") {
    res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Bad secret" } });
    return;
  }
  const a = Buffer.from(presented);
  const b = Buffer.from(env.LMS_S2S_SECRET);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    logger.warn({ path: req.path }, "LMS service call: bad secret");
    res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Bad secret" } });
    return;
  }
  next();
}

router.use(lmsOnly);

/**
 * Whether finance knows a student: a customer with this email, in any
 * organization, that has not been archived.
 *
 * The LMS asks before an admin approves a student — or creates one already
 * approved — and refuses when the answer is no, so nobody gets into a course by
 * hand unless their sale reached finance. It answers which organizations, so
 * the admin sees where; nothing else about the customer leaves finance.
 */
router.post(
  "/customer-check",
  asyncHandler(async (req: Request, res: Response) => {
    const email = String((req.body as { email?: unknown } | undefined)?.email ?? "").trim().toLowerCase();
    if (!email || email.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(email)) {
      throw new AppError("VALIDATION_ERROR", "A valid email is required");
    }
    // Stored lowercased and trimmed. "Not archived" rather than "active", so a
    // customer from before the status existed still counts.
    const rows = await Customer.find({ email, status: { $ne: "archived" } })
      .select("organizationId")
      .lean<{ organizationId: unknown }[]>();
    const orgIds = [...new Set(rows.map((r) => String(r.organizationId)))];
    const orgs = orgIds.length
      ? await Organization.find({ _id: { $in: orgIds } }).select("name").lean<{ name?: string }[]>()
      : [];
    ok(res, {
      exists: rows.length > 0,
      organizations: orgs.map((o) => o.name ?? "").filter(Boolean).sort(),
    });
  }),
);

export default router;
