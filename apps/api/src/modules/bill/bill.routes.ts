import { Router } from "express";
import { createBillSchema, updateBillSchema, recordBillPaymentSchema } from "@delta/shared";
import { authenticate } from "../../middleware/auth";
import { requirePermission } from "../../middleware/rbac";
import { validateBody } from "../../middleware/validate";
import * as c from "./bill.controller";

const router = Router();
router.use(authenticate);

router.get("/", requirePermission("bill:read"), c.list);
router.get("/:id", requirePermission("bill:read"), c.get);
router.post("/", requirePermission("bill:create"), validateBody(createBillSchema), c.create);
router.patch("/:id", requirePermission("bill:update"), validateBody(updateBillSchema), c.update);
router.post("/:id/approve", requirePermission("bill:approve"), c.approve);
router.post("/:id/reject", requirePermission("bill:approve"), c.reject);
router.post("/:id/payments", requirePermission("bill:update"), validateBody(recordBillPaymentSchema), c.recordPayment);
router.post("/:id/void", requirePermission("bill:delete"), c.voidBill);

export default router;
