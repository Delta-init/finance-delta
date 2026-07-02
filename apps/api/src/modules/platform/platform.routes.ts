import { Router } from "express";
import { createOrganizationSchema, inviteMemberSchema } from "@delta/shared";
import { authenticate } from "../../middleware/auth";
import { requireSuperAdmin } from "../../middleware/rbac";
import { validateBody } from "../../middleware/validate";
import * as c from "./platform.controller";

const router = Router();
router.use(authenticate, requireSuperAdmin);

router.get("/organizations", c.listOrgs);
router.post("/organizations", validateBody(createOrganizationSchema), c.createOrg);
router.get("/organizations/:orgId/roles", c.listOrgRoles);
router.get("/organizations/:orgId/members", c.listMembers);
router.post("/organizations/:orgId/members", validateBody(inviteMemberSchema), c.inviteMember);
router.delete("/organizations/:orgId/members/:userId", c.removeMember);

export default router;
