import { Router } from "express";
import { createExpenseSchema, updateExpenseSchema, rejectExpenseSchema } from "@delta/shared";
import { authenticate } from "../../middleware/auth";
import { requireAnyPermission, requirePermission } from "../../middleware/rbac";
import { validateBody } from "../../middleware/validate";
import { parseUpload } from "../../middleware/upload";
import * as c from "./expense.controller";

const router = Router();
router.use(authenticate);

router.get("/", requireAnyPermission("expense:read", "expense:read:own"), c.list);
router.get("/:id", requireAnyPermission("expense:read", "expense:read:own"), c.get);
router.post("/", requireAnyPermission("expense:create", "expense:write:own"), validateBody(createExpenseSchema), c.create);
router.patch("/:id", requireAnyPermission("expense:update", "expense:write:own"), validateBody(updateExpenseSchema), c.update);
router.post("/:id/submit", requireAnyPermission("expense:create", "expense:write:own"), c.submit);

// Receipts. Held to the same permission as editing the claim, and the service
// additionally refuses once it has gone to an approver — the evidence a claim
// was approved against should not change afterwards.
router.post(
  "/:id/attachments",
  requireAnyPermission("expense:update", "expense:write:own"),
  parseUpload,
  c.addAttachment,
);
router.delete(
  "/:id/attachments/:key(*)",
  requireAnyPermission("expense:update", "expense:write:own"),
  c.removeAttachment,
);
router.post("/:id/approve", requirePermission("expense:approve"), c.approve);
router.post("/:id/reject", requirePermission("expense:approve"), validateBody(rejectExpenseSchema), c.reject);
router.post("/:id/void", requirePermission("expense:delete"), c.voidExpense);
// Recurring template controls
router.post("/:id/recurrence/pause", requirePermission("expense:update"), c.pauseRecurrence);
router.post("/:id/recurrence/resume", requirePermission("expense:update"), c.resumeRecurrence);
router.post("/:id/recurrence/stop", requirePermission("expense:update"), c.stopRecurrence);

export default router;
