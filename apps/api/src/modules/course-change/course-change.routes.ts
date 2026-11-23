import { Router } from "express";
import { decideCourseChangeSchema } from "@delta/shared";
import { authenticate } from "../../middleware/auth";
import { requirePermission } from "../../middleware/rbac";
import { validateBody } from "../../middleware/validate";
import { asyncHandler, ok } from "../../lib/http";
import { decideCourseChange, getCourseChange } from "./course-change.service";

/**
 * Course changes from the sales CRMs (2026-11-23), for whoever approves
 * enrolments — the same permission as balance payments: read one to review it
 * on the Approvals page, and decide it there.
 */
const router = Router();
router.use(authenticate);
router.use(requirePermission("invoice:write"));

router.get("/:id", asyncHandler(async (req, res) => {
  ok(res, await getCourseChange(req.auth!.organizationId, String(req.params.id)));
}));

router.post("/:id/decision", validateBody(decideCourseChangeSchema), asyncHandler(async (req, res) => {
  ok(res, await decideCourseChange(req.auth!, String(req.params.id), req.body));
}));

export default router;
