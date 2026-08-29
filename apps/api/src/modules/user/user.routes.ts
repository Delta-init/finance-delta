import { Router } from "express";
import { createUserSchema, updateUserSchema } from "@delta/shared";
import { authenticate } from "../../middleware/auth";
import { requirePermission } from "../../middleware/rbac";
import { validateBody } from "../../middleware/validate";
import * as userController from "./user.controller";

const router = Router();

router.use(authenticate);

router.get("/", requirePermission("user:read"), userController.list);
router.post(
  "/",
  requirePermission("user:create"),
  validateBody(createUserSchema),
  userController.create,
);
// Granting somebody a way in is a change to their access, so it sits behind
// the same permission as editing them.
router.post("/:id/invite", requirePermission("user:update"), userController.invite);

router.patch(
  "/:id",
  requirePermission("user:update"),
  validateBody(updateUserSchema),
  userController.update,
);

export default router;
