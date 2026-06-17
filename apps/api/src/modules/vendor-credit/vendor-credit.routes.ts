import { Router } from "express";
import { createVendorCreditSchema, applyVendorCreditSchema } from "@delta/shared";
import { authenticate } from "../../middleware/auth";
import { requirePermission } from "../../middleware/rbac";
import { validateBody } from "../../middleware/validate";
import * as c from "./vendor-credit.controller";

const router = Router();
router.use(authenticate);

router.get("/", requirePermission("bill:read"), c.list);
router.get("/:id", requirePermission("bill:read"), c.get);
router.post("/", requirePermission("bill:create"), validateBody(createVendorCreditSchema), c.create);
router.post("/:id/issue", requirePermission("bill:update"), c.issue);
router.post("/:id/apply", requirePermission("bill:update"), validateBody(applyVendorCreditSchema), c.apply);
router.post("/:id/void", requirePermission("bill:delete"), c.voidCredit);

export default router;
