import { Router } from "express";
import { createFundingRequestSchema, reviewFundingRequestSchema, upsertBudgetAllocationSchema, upsertCategoryBudgetSchema } from "@delta/shared";
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
// By expense category (2026-11-09): company-wide spending, so only for whoever sees every department's budget.
router.get("/categories", requireAnyPermission("budget:read", "budget:manage", "budget:approve"), c.categoryBudget);
router.get("/category-allocations", requirePermission("budget:manage"), c.categoryAllocations);
router.patch("/category-allocations", requirePermission("budget:manage"), validateBody(upsertCategoryBudgetSchema), c.saveCategoryAllocation);
export default router;
