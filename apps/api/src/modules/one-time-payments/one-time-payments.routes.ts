import { Router } from "express";
import { markOneTimePaidSchema, rejectOneTimePaymentSchema } from "@delta/shared";
import { authenticate } from "../../middleware/auth";
import { requirePermission } from "../../middleware/rbac";
import { validateBody } from "../../middleware/validate";
import * as c from "./one-time-payments.controller";

/**
 * Paying a one-time payment from HRMS records a paid expense, so — like a
 * salary advance or a purchase request — it is gated on `expense:approve`.
 */
const router = Router();
router.use(authenticate);

router.get("/", requirePermission("expense:approve"), c.list);
// Finance's full record: paid, refused, or all (2026-10-21).
router.get("/history", requirePermission("expense:approve"), c.history);
router.post("/:id/paid", requirePermission("expense:approve"), validateBody(markOneTimePaidSchema), c.markPaid);
router.post("/:id/reject", requirePermission("expense:approve"), validateBody(rejectOneTimePaymentSchema), c.reject);

export default router;
