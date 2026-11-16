import { Router } from "express";
import { payReimbursementSchema, rejectReimbursementSchema } from "@delta/shared";
import { authenticate } from "../../middleware/auth";
import { requirePermission } from "../../middleware/rbac";
import { validateBody } from "../../middleware/validate";
import * as c from "./reimbursements.controller";

/**
 * Paying an employee's reimbursement claim from HRMS records a paid expense, so — like a salary advance, a one-time
 * payment or a purchase request — it is gated on `expense:approve` (2026-11-16).
 */
const router = Router();
router.use(authenticate);

router.get("/", requirePermission("expense:approve"), c.list);
// Finance's record: paid, refused, or all that reached finance.
router.get("/history", requirePermission("expense:approve"), c.history);
router.post("/:id/pay", requirePermission("expense:approve"), validateBody(payReimbursementSchema), c.pay);
router.post("/:id/reject", requirePermission("expense:approve"), validateBody(rejectReimbursementSchema), c.reject);

export default router;
