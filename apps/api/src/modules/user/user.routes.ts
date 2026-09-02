import { Router } from "express";
import { createUserSchema, updateUserSchema } from "@delta/shared";
import { authenticate } from "../../middleware/auth";
import { requirePermission, requireAnyPermission } from "../../middleware/rbac";
import { validateBody } from "../../middleware/validate";
import * as userController from "./user.controller";

const router = Router();

router.use(authenticate);

router.get("/", requirePermission("user:read"), userController.list);
// Names only, for anybody who can raise an invoice: a counsellor naming the
// colleague who ran the meeting cannot read the user list, and should not have
// to in order to pick a name that is already on every invoice they can see.
// Before "/:id" would matter if one existed on GET; kept here for clarity.
router.get(
  "/colleagues",
  requireAnyPermission("invoice:write", "invoice:write:own"),
  userController.colleagues,
);
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

// Removing somebody, which the service refuses while their name is on a
// document. Suspending is the ordinary answer and is a plain update.
router.delete("/:id", requirePermission("user:delete"), userController.remove);

export default router;
