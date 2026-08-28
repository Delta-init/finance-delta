import { Router } from "express";
import { authenticate } from "../../middleware/auth";
import { requirePermission } from "../../middleware/rbac";
import { validateBody } from "../../middleware/validate";
import {
  addAdjustmentsSchema, importRunSchema, payRunSchema, returnRunSchema, reversePaymentSchema,
} from "./payroll.schemas";
import * as c from "./payroll.controller";

const router = Router();
router.use(authenticate);

// What HR is offering, and what a given month would bring in.
router.get("/available", requirePermission("payroll:read"), c.listAvailable);
router.get("/import/preview", requirePermission("payroll:read"), c.previewImport);
router.post("/import", requirePermission("payroll:write"), validateBody(importRunSchema), c.importRun);

router.get("/reconciliation", requirePermission("payroll:read"), c.reconciliation);
router.get("/runs", requirePermission("payroll:read"), c.listRuns);
router.get("/runs/:id", requirePermission("payroll:read"), c.getRun);

// Step two of the handover: what accounts add or take off. Every one of these
// writes through to HRMS, so the payslip matches what is actually paid.
router.post("/runs/:id/adjustments", requirePermission("payroll:write"), validateBody(addAdjustmentsSchema), c.addAdjustments);
router.post("/runs/:id/commissions/pull", requirePermission("payroll:write"), c.pullCommissions);
router.delete("/runs/:id/adjustments/:externalId", requirePermission("payroll:write"), c.removeAdjustment);

// Sign-off and payment. "pay" is its own permission, separate from approve and
// from write: the person who signs a payroll off should not be the same one who
// moves the money unless somebody deliberately decided so.
router.post("/runs/:id/approve", requirePermission("payroll:approve"), c.approveRun);
router.post("/runs/:id/return", requirePermission("payroll:approve"), validateBody(returnRunSchema), c.returnRun);
router.post("/runs/:id/pay", requirePermission("payroll:pay"), validateBody(payRunSchema), c.payRun);
// Retrying a lost acknowledgement moves no money, so it sits with write.
router.post("/runs/:id/payments/:paymentId/retry-sync", requirePermission("payroll:write"), c.retrySync);
// Reversing moves money back, so it sits with pay rather than write.
router.post("/runs/:id/payments/:paymentId/reverse", requirePermission("payroll:pay"), validateBody(reversePaymentSchema), c.reversePayment);

export default router;
