import { Router } from "express";
import { approveAdvanceSchema, rejectAdvanceSchema } from "@delta/shared";
import { authenticate } from "../../middleware/auth";
import { requirePermission } from "../../middleware/rbac";
import { validateBody } from "../../middleware/validate";
import * as c from "./advances.controller";

/**
 * Paying out a salary advance records an approved expense, so — like a
 * purchase request — it is gated on `expense:approve`: whoever may approve
 * the company's spending may approve this.
 */
const router = Router();
router.use(authenticate);

router.get("/", requirePermission("expense:approve"), c.list);
router.post("/:id/approve", requirePermission("expense:approve"), validateBody(approveAdvanceSchema), c.approve);
router.post("/:id/reject", requirePermission("expense:approve"), validateBody(rejectAdvanceSchema), c.reject);

export default router;
