import { Router } from "express";
import { updateOrganizationSchema } from "@delta/shared";
import { authenticate } from "../../middleware/auth";
import { requirePermission } from "../../middleware/rbac";
import { validateBody } from "../../middleware/validate";
import * as c from "./organization.controller";

const router = Router();
router.use(authenticate);

router.get("/settings", requirePermission("organization:read"), c.getSettings);
router.patch("/settings", requirePermission("organization:update"), validateBody(updateOrganizationSchema), c.updateSettings);

export default router;
