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
router.patch(
  "/:id",
  requirePermission("customer:update"),
  validateBody(updateCustomerSchema),
  customerController.update,
);
router.delete("/:id", requirePermission("customer:delete"), customerController.remove);

export default router;
