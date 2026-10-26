import { Router } from "express";
import { authenticate } from "../../middleware/auth";
import { requireAnyPermission } from "../../middleware/rbac";
import * as c from "./dashboard.controller";

const router = Router();
router.use(authenticate);
// A company financial overview: revenue, receivables, aging, top customers.
// It had no permission check at all, so anybody with a login could read it —
// including the payroll accounts, whose holders are not finance staff.
//
// Either broad read permission, rather than report:read alone: a salesperson
// has invoice:read and has always had this screen, and narrowing it to
// report:read would take it away from them. What it excludes is somebody whose
// only access is to their own records.
router.get("/", requireAnyPermission("report:read", "invoice:read"), c.getStats);
// The records behind a figure (2026-10-26); expense figures need more — see the controller.
router.get("/breakdown", requireAnyPermission("report:read", "invoice:read"), c.getBreakdown);
export default router;
