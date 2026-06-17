import { Router } from "express";
import { authenticate } from "../../middleware/auth";
import { requirePermission } from "../../middleware/rbac";
import * as c from "./salesorder.controller";

const router = Router();
router.use(authenticate);

router.get("/", requirePermission("salesorder:read"), c.list);
router.get("/:id", requirePermission("salesorder:read"), c.get);
router.post("/:id/cancel", requirePermission("salesorder:update"), c.cancel);

export default router;
