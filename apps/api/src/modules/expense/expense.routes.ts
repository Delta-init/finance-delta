import { Router } from "express";
import { createExpenseSchema, updateExpenseSchema, rejectExpenseSchema } from "@delta/shared";
import { authenticate } from "../../middleware/auth";
import { requirePermission } from "../../middleware/rbac";
import { validateBody } from "../../middleware/validate";
import * as c from "./expense.controller";

const router = Router();
router.use(authenticate);

router.get("/", requirePermission("expense:read"), c.list);
router.get("/:id", requirePermission("expense:read"), c.get);
router.post("/", requirePermission("expense:create"), validateBody(createExpenseSchema), c.create);
router.patch("/:id", requirePermission("expense:update"), validateBody(updateExpenseSchema), c.update);
router.post("/:id/submit", requirePermission("expense:create"), c.submit);
router.post("/:id/approve", requirePermission("expense:approve"), c.approve);
router.post("/:id/reject", requirePermission("expense:approve"), validateBody(rejectExpenseSchema), c.reject);
router.post("/:id/void", requirePermission("expense:delete"), c.voidExpense);
// Recurring template controls
router.post("/:id/recurrence/pause", requirePermission("expense:update"), c.pauseRecurrence);
router.post("/:id/recurrence/resume", requirePermission("expense:update"), c.resumeRecurrence);
router.post("/:id/recurrence/stop", requirePermission("expense:update"), c.stopRecurrence);

export default router;
