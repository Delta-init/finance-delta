import { Router } from "express";
import { createVendorSchema, updateVendorSchema } from "@delta/shared";
import { authenticate } from "../../middleware/auth";
import { requirePermission } from "../../middleware/rbac";
import { validateBody } from "../../middleware/validate";
import * as c from "./vendor.controller";

const router = Router();
router.use(authenticate);

router.get("/", requirePermission("vendor:read"), c.list);
router.get("/:id", requirePermission("vendor:read"), c.get);
router.post("/", requirePermission("vendor:create"), validateBody(createVendorSchema), c.create);
router.patch("/:id", requirePermission("vendor:update"), validateBody(updateVendorSchema), c.update);
router.delete("/:id", requirePermission("vendor:delete"), c.remove);

export default router;
