import { Router } from "express";
import {
  createInvoiceSchema,
  recordPaymentSchema,
  returnEnrolmentSchema,
  updateInvoiceSchema,
} from "@delta/shared";
import { authenticate } from "../../middleware/auth";
import { requireAnyPermission, requirePermission } from "../../middleware/rbac";
import { validateBody } from "../../middleware/validate";
import { parseUpload } from "../../middleware/upload";
import * as c from "./invoice.controller";

const router = Router();
router.use(authenticate);

router.get("/", requireAnyPermission("invoice:read", "invoice:read:own"), c.list);
router.get("/:id", requireAnyPermission("invoice:read", "invoice:read:own"), c.get);
router.post("/", requireAnyPermission("invoice:write", "invoice:write:own"), validateBody(createInvoiceSchema), c.create);
router.patch("/:id", requireAnyPermission("invoice:write", "invoice:write:own"), validateBody(updateInvoiceSchema), c.update);
router.delete("/:id", requirePermission("invoice:write"), c.remove);

router.post("/:id/send", requireAnyPermission("invoice:write", "invoice:write:own"), c.send);
router.post("/:id/resend", requireAnyPermission("invoice:write", "invoice:write:own"), c.resend);
// Approving an enrolment is what lets its invoice be sent and paid, so it sits
// behind the same permission as those — which the counsellor who raised it
// does not have.
router.post("/:id/enrolment/approve", requirePermission("invoice:write"), c.approveEnrolment);
router.post(
  "/:id/enrolment/return",
  requirePermission("invoice:write"),
  validateBody(returnEnrolmentSchema),
  c.returnEnrolment,
);
// The one transition the counsellor may make: putting a corrected enrolment
// back in front of an approver.
router.post(
  "/:id/enrolment/resubmit",
  requireAnyPermission("invoice:write", "invoice:write:own"),
  c.resubmitEnrolment,
);

router.post("/:id/void", requirePermission("invoice:write"), c.voidInvoice);
router.post("/:id/payments", requirePermission("invoice:write"), parseUpload, validateBody(recordPaymentSchema), c.recordPayment);
router.patch("/:id/payments/:paymentId", requirePermission("invoice:write"), validateBody(recordPaymentSchema), c.updatePayment);

export default router;
