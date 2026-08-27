import { Router } from "express";
import { authenticate } from "../../middleware/auth";
import { requirePermission } from "../../middleware/rbac";
import { validateBody } from "../../middleware/validate";
import { applySyncSchema, createOrgLinkSchema } from "./mapping.schemas";
import * as c from "./mapping.controller";

const router = Router();
router.use(authenticate);

router.get("/health", requirePermission("payroll:read"), c.health);

// Organization links
router.get("/hrms-organizations", requirePermission("payroll:write"), c.listHrmsOrganizations);
router.get("/org-links", requirePermission("payroll:read"), c.listOrgLinks);
router.post("/org-links", requirePermission("payroll:write"), validateBody(createOrgLinkSchema), c.createOrgLink);
router.delete("/org-links/:id", requirePermission("payroll:write"), c.removeOrgLink);

// Sync. The preview is a read even though it calls out to HRMS; only the apply
// writes, and it is gated behind the write permission accordingly.
router.get("/sync/preview", requirePermission("payroll:read"), c.previewSync);
router.post("/sync/apply", requirePermission("payroll:write"), validateBody(applySyncSchema), c.applySync);

// The mapped roster
router.get("/employees", requirePermission("payroll:read"), c.listEmployees);

export default router;
