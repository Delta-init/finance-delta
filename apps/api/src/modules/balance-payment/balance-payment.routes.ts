import { Router } from "express";
import { decideBalancePaymentSchema } from "@delta/shared";
import { authenticate } from "../../middleware/auth";
import { requirePermission } from "../../middleware/rbac";
import { validateBody } from "../../middleware/validate";
import { asyncHandler, ok } from "../../lib/http";
import { decideBalancePayment, getBalancePayment } from "./balance-payment.service";

/**
 * Balance payments from the sales CRMs, for whoever approves enrolments: read
 * one to review it on the Approvals page, and decide it there.
 */
const router = Router();
router.use(authenticate);
router.use(requirePermission("invoice:write"));

router.get("/:id", asyncHandler(async (req, res) => {
  ok(res, await getBalancePayment(req.auth!.organizationId, String(req.params.id)));
}));

router.post("/:id/decision", validateBody(decideBalancePaymentSchema), asyncHandler(async (req, res) => {
  ok(res, await decideBalancePayment(req.auth!, String(req.params.id), req.body));
}));

export default router;
