import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/auth";
import { requirePermission } from "../../middleware/rbac";
import { parseQuery } from "../../middleware/validate";
import { asyncHandler, ok } from "../../lib/http";
import { listEmailLogs } from "./email-log.service";

const router = Router();
router.use(authenticate);

const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const query = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().max(200).optional(),
  kind: z.string().max(40).optional(),
  state: z.enum(["sent", "failed", "no_address", "not_configured"]).optional(),
  from: DAY.optional(),
  to: DAY.optional(),
});

/*
 * The email log: admins and accountants (the user, 2026-10-07) — the people
 * who keep the books, which is what ledger:write already marks out.
 */
router.get("/", requirePermission("ledger:write"), asyncHandler(async (req, res) => {
  const { rows, meta } = await listEmailLogs(req.auth!.organizationId, parseQuery(query, req.query));
  ok(res, rows, meta);
}));

export default router;
