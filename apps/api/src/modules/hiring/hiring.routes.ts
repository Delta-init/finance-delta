import { Router } from "express";
import { approveHiringSchema, rejectHiringSchema } from "@delta/shared";
import { authenticate } from "../../middleware/auth";
import { requirePermission } from "../../middleware/rbac";
import { validateBody } from "../../middleware/validate";
import * as c from "./hiring.controller";

/**
 * Hiring requests that need finance's budget approval (2026-10-15). Decided by
 * whoever may approve the company's spending — `expense:approve`, as purchase
 * requests and salary advances are.
 */
const router = Router();
router.use(authenticate);

router.get("/", requirePermission("expense:approve"), c.list);
router.post("/:id/approve", requirePermission("expense:approve"), validateBody(approveHiringSchema), c.approve);
router.post("/:id/reject", requirePermission("expense:approve"), validateBody(rejectHiringSchema), c.reject);

export default router;
