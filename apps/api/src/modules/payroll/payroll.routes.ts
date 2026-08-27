import { Router } from "express";
import { authenticate } from "../../middleware/auth";
import { requirePermission } from "../../middleware/rbac";
import { validateBody } from "../../middleware/validate";
import { importRunSchema } from "./payroll.schemas";
import * as c from "./payroll.controller";

const router = Router();
router.use(authenticate);

// What HR is offering, and what a given month would bring in.
router.get("/available", requirePermission("payroll:read"), c.listAvailable);
router.get("/import/preview", requirePermission("payroll:read"), c.previewImport);
router.post("/import", requirePermission("payroll:write"), validateBody(importRunSchema), c.importRun);

router.get("/runs", requirePermission("payroll:read"), c.listRuns);
router.get("/runs/:id", requirePermission("payroll:read"), c.getRun);

export default router;
