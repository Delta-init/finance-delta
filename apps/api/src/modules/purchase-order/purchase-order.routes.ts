import { Router } from "express";
import { createPOSchema, updatePOSchema } from "@delta/shared";
import { authenticate } from "../../middleware/auth";
import { requirePermission } from "../../middleware/rbac";
import { validateBody } from "../../middleware/validate";
import * as c from "./purchase-order.controller";

const router = Router();
router.use(authenticate);

router.get("/", requirePermission("po:read"), c.list);
router.get("/:id", requirePermission("po:read"), c.get);
router.post("/", requirePermission("po:create"), validateBody(createPOSchema), c.create);
router.patch("/:id", requirePermission("po:update"), validateBody(updatePOSchema), c.update);
router.post("/:id/send", requirePermission("po:update"), c.send);
router.post("/:id/receive", requirePermission("po:update"), c.receive);
router.post("/:id/convert-to-bill", requirePermission("bill:create"), c.convertToBill);
router.post("/:id/cancel", requirePermission("po:update"), c.cancel);

export default router;
