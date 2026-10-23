import { Router } from "express";
import { approveProcurementSchema, rejectProcurementSchema } from "@delta/shared";
import { authenticate } from "../../middleware/auth";
import { requirePermission } from "../../middleware/rbac";
import { validateBody } from "../../middleware/validate";
import * as c from "./procurement.controller";

/**
 * Approving a purchase request records an approved expense, so it is gated on
 * `expense:approve` rather than a permission of its own — anyone who may
 * approve the company's spending may approve the request that becomes some.
 * The list is only for them too: it is a queue of decisions, not a report.
 */
const router = Router();
router.use(authenticate);

router.get("/", requirePermission("expense:approve"), c.list);
// Finance's full record: every request in any status, and what was already bought (2026-10-23).
router.get("/history", requirePermission("expense:approve"), c.history);
router.post("/:id/approve", requirePermission("expense:approve"), validateBody(approveProcurementSchema), c.approve);
router.post("/:id/reject", requirePermission("expense:approve"), validateBody(rejectProcurementSchema), c.reject);

export default router;
