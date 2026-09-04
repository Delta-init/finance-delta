import { Router } from "express";
import { createCustomerSchema, updateCustomerSchema } from "@delta/shared";
import { authenticate } from "../../middleware/auth";
import { requirePermission } from "../../middleware/rbac";
import { validateBody } from "../../middleware/validate";
import * as customerController from "./customer.controller";

const router = Router();
router.use(authenticate);

router.get("/", requirePermission("customer:read"), customerController.list);
router.get("/:id", requirePermission("customer:read"), customerController.get);
router.get("/:id/statement", requirePermission("customer:read"), customerController.statement);
router.post(
  "/",
  requirePermission("customer:create"),
  validateBody(createCustomerSchema),
  customerController.create,
);
// A client buying a second course is not a duplicate. Same permission as
// creating one, since that is what it does when nobody matches.
router.post(
  "/find-or-create",
  requirePermission("customer:create"),
  validateBody(createCustomerSchema),
  customerController.findOrCreate,
);
router.patch(
  "/:id",
  requirePermission("customer:update"),
  validateBody(updateCustomerSchema),
  customerController.update,
);
router.delete("/:id", requirePermission("customer:delete"), customerController.remove);

export default router;
