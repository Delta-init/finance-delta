import { Router } from "express";
import { updateOrganizationSchema, upsertTaxConfigSchema } from "@delta/shared";
import { authenticate } from "../../middleware/auth";
import { requirePermission } from "../../middleware/rbac";
import { validateBody } from "../../middleware/validate";
import { parseUpload } from "../../middleware/upload";
import * as c from "./organization.controller";

const router = Router();
router.use(authenticate);

router.get("/mine", c.getMyOrganizations);
router.get("/settings", requirePermission("organization:read"), c.getSettings);
router.patch("/settings", requirePermission("organization:update"), validateBody(updateOrganizationSchema), c.updateSettings);
// The logo as a file, rather than a link to one.
router.post("/logo", requirePermission("organization:update"), parseUpload, c.uploadLogo);

router.get("/tax-config", requirePermission("organization:read"), c.getTaxConfig);
router.patch("/tax-config", requirePermission("organization:update"), validateBody(upsertTaxConfigSchema), c.upsertTaxConfig);

export default router;
