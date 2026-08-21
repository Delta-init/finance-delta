import { Router } from "express";
import { createInvoiceSchema, recordPaymentSchema, updateInvoiceSchema } from "@delta/shared";
import { authenticate } from "../../middleware/auth";
import { requirePermission } from "../../middleware/rbac";
import { validateBody } from "../../middleware/validate";
import { parseUpload } from "../../middleware/upload";
import * as c from "./invoice.controller";

const router = Router();
router.use(authenticate);

router.get("/", requirePermission("invoice:read"), c.list);
router.get("/:id", requirePermission("invoice:read"), c.get);
router.post("/", requirePermission("invoice:write"), validateBody(createInvoiceSchema), c.create);
router.patch("/:id", requirePermission("invoice:write"), validateBody(updateInvoiceSchema), c.update);
router.delete("/:id", requirePermission("invoice:write"), c.remove);

router.post("/:id/send", requirePermission("invoice:write"), c.send);
router.post("/:id/resend", requirePermission("invoice:write"), c.resend);
router.post("/:id/void", requirePermission("invoice:write"), c.voidInvoice);
router.post("/:id/payments", requirePermission("invoice:write"), parseUpload, validateBody(recordPaymentSchema), c.recordPayment);
router.patch("/:id/payments/:paymentId", requirePermission("invoice:write"), validateBody(recordPaymentSchema), c.updatePayment);

export default router;
