import { Router } from "express";
import { authenticate } from "../../middleware/auth";
import { requirePermission } from "../../middleware/rbac";
import { validateBody } from "../../middleware/validate";
import { addAdjustmentsSchema, importRunSchema } from "./payroll.schemas";
import * as c from "./payroll.controller";

const router = Router();
router.use(authenticate);

// What HR is offering, and what a given month would bring in.
router.get("/available", requirePermission("payroll:read"), c.listAvailable);
router.get("/import/preview", requirePermission("payroll:read"), c.previewImport);
router.post("/import", requirePermission("payroll:write"), validateBody(importRunSchema), c.importRun);

router.get("/runs", requirePermission("payroll:read"), c.listRuns);
router.get("/runs/:id", requirePermission("payroll:read"), c.getRun);

// Step two of the handover: what accounts add or take off. Every one of these
// writes through to HRMS, so the payslip matches what is actually paid.
router.post("/runs/:id/adjustments", requirePermission("payroll:write"), validateBody(addAdjustmentsSchema), c.addAdjustments);
router.post("/runs/:id/commissions/pull", requirePermission("payroll:write"), c.pullCommissions);
router.delete("/runs/:id/adjustments/:externalId", requirePermission("payroll:write"), c.removeAdjustment);

export default router;
