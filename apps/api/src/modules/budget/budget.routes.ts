import { Router } from "express";
import { createFundingRequestSchema, reviewFundingRequestSchema, upsertBudgetAllocationSchema } from "@delta/shared";
import { authenticate } from "../../middleware/auth";
import { requireAnyPermission, requirePermission } from "../../middleware/rbac";
import { validateBody } from "../../middleware/validate";
import * as c from "./budget.controller";

const router = Router();
router.use(authenticate);
router.get("/summary", requireAnyPermission("budget:read", "budget:read:own", "budget:manage", "budget:approve", "budget:request"), c.summary);
router.get("/allocations", requirePermission("budget:manage"), c.allocations);
router.get("/requests", requireAnyPermission("budget:read", "budget:read:own", "budget:manage", "budget:approve", "budget:request"), c.requests);
router.post("/requests", requirePermission("budget:request"), validateBody(createFundingRequestSchema), c.createRequest);
router.post("/requests/:id/review", requirePermission("budget:approve"), validateBody(reviewFundingRequestSchema), c.reviewRequest);
router.patch("/allocations", requirePermission("budget:manage"), validateBody(upsertBudgetAllocationSchema), c.saveAllocation);
export default router;
