import { Router } from "express";
import { approveCsCommissionSchema, payCsCommissionSchema, recordCsCommissionPaymentSchema, revokeCsCommissionSchema } from "@delta/shared";
import { authenticate } from "../../middleware/auth";
import { requirePermission } from "../../middleware/rbac";
import { validateBody } from "../../middleware/validate";
import { parseUpload } from "../../middleware/upload";
import * as c from "./cs-commission.controller";

/*
 * The CS Portal's commission (2026-11-03), like the CRMs': read with commission:read; approved by somebody tagged
 * Manager (or a super admin — the service checks); paid, with the receipt, with commission:write.
 */
const router = Router();
router.use(authenticate);

router.get("/", requirePermission("commission:read"), c.period);
router.get("/invoices/:id", requirePermission("commission:read"), c.invoice);
router.post("/approve", requirePermission("commission:read"), validateBody(approveCsCommissionSchema), c.approve);
router.post("/revoke", requirePermission("commission:read"), validateBody(revokeCsCommissionSchema), c.revoke);
router.post("/uploads", requirePermission("commission:write"), parseUpload, c.upload);
router.post("/pay", requirePermission("commission:write"), validateBody(payCsCommissionSchema), c.pay);
router.post("/record-payment", requirePermission("commission:write"), validateBody(recordCsCommissionPaymentSchema), c.recordPayment);

export default router;
