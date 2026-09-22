import { Router } from "express";
import { authenticate } from "../../middleware/auth";
import { requirePermission } from "../../middleware/rbac";
import * as c from "./procurement.controller";

/**
 * Approving a purchase request is the same authority as raising the order it
 * becomes, so it is gated on `po:create` rather than a permission of its own —
 * anyone who may commit the company to a purchase order may approve the
 * request that produces one.
 */
const router = Router();
router.use(authenticate);

router.get("/", requirePermission("po:read"), c.list);
router.post("/:id/approve", requirePermission("po:create"), c.approve);
router.post("/:id/reject", requirePermission("po:create"), c.reject);

export default router;
