import { Router } from "express";
import { authenticate } from "../../middleware/auth";
import { requirePermission } from "../../middleware/rbac";
import * as c from "./payment.controller";

const router = Router();
router.use(authenticate);

router.get("/", requirePermission("invoice:read"), c.list);
router.get("/:id", requirePermission("invoice:read"), c.get);

export default router;
