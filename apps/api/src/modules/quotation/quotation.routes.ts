import { Router } from "express";
import {
  convertQuotationSchema,
  convertToInvoiceSchema,
  createQuotationSchema,
  updateQuotationSchema,
} from "@delta/shared";
import { authenticate } from "../../middleware/auth";
import { requirePermission } from "../../middleware/rbac";
import { validateBody } from "../../middleware/validate";
import * as c from "./quotation.controller";

const router = Router();
router.use(authenticate);

router.get("/", requirePermission("quotation:read"), c.list);
router.get("/:id", requirePermission("quotation:read"), c.get);
router.post("/", requirePermission("quotation:create"), validateBody(createQuotationSchema), c.create);
router.patch("/:id", requirePermission("quotation:update"), validateBody(updateQuotationSchema), c.update);
router.delete("/:id", requirePermission("quotation:delete"), c.remove);

router.post("/:id/send", requirePermission("quotation:update"), c.send);
router.post("/:id/accept", requirePermission("quotation:update"), c.accept);
router.post("/:id/decline", requirePermission("quotation:update"), c.decline);
router.post(
  "/:id/convert",
  requirePermission("salesorder:create"),
  validateBody(convertQuotationSchema),
  c.convert,
);
router.post("/:id/convert-invoice", requirePermission("quotation:update"), validateBody(convertToInvoiceSchema), c.convertInvoice);

export default router;
