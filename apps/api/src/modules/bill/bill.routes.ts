import { Router } from "express";
import { createBillSchema, updateBillSchema, recordBillPaymentSchema, updateBillNotesSchema } from "@delta/shared";
import { authenticate } from "../../middleware/auth";
import { requirePermission } from "../../middleware/rbac";
import { validateBody } from "../../middleware/validate";
import { parseUpload } from "../../middleware/upload";
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
router.patch("/:id/notes", requirePermission("bill:update"), validateBody(updateBillNotesSchema), c.updateNotes);
router.post("/:id/attachments", requirePermission("bill:update"), parseUpload, c.addAttachment);
router.delete("/:id/attachments/:attId", requirePermission("bill:update"), c.removeAttachment);
router.post("/:id/void", requirePermission("bill:delete"), c.voidBill);

export default router;
