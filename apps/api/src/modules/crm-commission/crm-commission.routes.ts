import { Router } from "express";
import { approveCrmCommissionSchema, payCrmCommissionSchema, revokeCrmCommissionSchema } from "@delta/shared";
import { authenticate } from "../../middleware/auth";
import { requirePermission } from "../../middleware/rbac";
import { validateBody } from "../../middleware/validate";
import { parseUpload } from "../../middleware/upload";
import * as c from "./crm-commission.controller";

/*
 * The sales CRMs' commission (2026-10-21): read with commission:read; approved by somebody tagged Manager (or a super
 * admin — the service checks); paid, with the receipt, with commission:write.
 */
const router = Router();
router.use(authenticate);

router.get("/", requirePermission("commission:read"), c.month);
router.post("/approve", requirePermission("commission:read"), validateBody(approveCrmCommissionSchema), c.approve);
router.post("/revoke", requirePermission("commission:read"), validateBody(revokeCrmCommissionSchema), c.revoke);
router.post("/uploads", requirePermission("commission:write"), parseUpload, c.upload);
router.post("/pay", requirePermission("commission:write"), validateBody(payCrmCommissionSchema), c.pay);

export default router;
