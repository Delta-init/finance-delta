import { Router } from "express";
import { createRoleSchema, updateRoleSchema } from "@delta/shared";
import { authenticate } from "../../middleware/auth";
import { requirePermission } from "../../middleware/rbac";
import { validateBody } from "../../middleware/validate";
import * as roleController from "./role.controller";

const router = Router();

router.use(authenticate);

router.get("/", requirePermission("role:read"), roleController.list);
router.post(
  "/",
  requirePermission("role:create"),
  validateBody(createRoleSchema),
  roleController.create,
);
router.patch(
  "/:id",
  requirePermission("role:update"),
  validateBody(updateRoleSchema),
  roleController.update,
);
router.delete("/:id", requirePermission("role:delete"), roleController.remove);

export default router;
