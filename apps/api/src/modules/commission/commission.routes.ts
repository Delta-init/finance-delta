import { Router } from "express";
import { authenticate } from "../../middleware/auth";
import { requirePermission } from "../../middleware/rbac";
import * as c from "./commission.controller";

const router = Router();
router.use(authenticate);

// Structures
router.get("/structures", requirePermission("commission:read"), c.listStructures);
router.get("/structures/:id", requirePermission("commission:read"), c.getStructure);
router.post("/structures", requirePermission("commission:write"), c.createStructure);
router.patch("/structures/:id", requirePermission("commission:write"), c.updateStructure);
router.post("/structures/:id/lock", requirePermission("commission:approve"), c.lockStructure);
router.post("/structures/:id/unlock", requirePermission("commission:approve"), c.unlockStructure);

// Records
router.get("/records", requirePermission("commission:read"), c.listRecords);
router.post("/records/mark-paid", requirePermission("commission:write"), c.markPaid);
router.post("/records/:id/cancel", requirePermission("commission:write"), c.cancelRecord);

// Report
router.get("/report", requirePermission("commission:read"), c.commissionReport);

export default router;
