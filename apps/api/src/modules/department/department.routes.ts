import { Router } from "express";
import { createDepartmentSchema, updateDepartmentSchema } from "@delta/shared";
import { authenticate } from "../../middleware/auth";
import { requirePermission } from "../../middleware/rbac";
import { validateBody } from "../../middleware/validate";
import * as c from "./department.controller";

const router = Router();
router.use(authenticate);

// Reads stay open to any authenticated org member — department names are
// low-sensitivity reference data used in customer/user/item dropdowns.
router.get("/", c.list);
router.get("/all", c.listAll);
// Writes require explicit permission (admins hold the "*" wildcard).
router.post("/", requirePermission("department:create"), validateBody(createDepartmentSchema), c.create);
// HRMS's departments brought in, renamed as there, people moved with them — what the hourly job does (2026-11-05).
router.post("/sync-hrms", requirePermission("department:update"), c.syncHrms);
router.patch("/:id", requirePermission("department:update"), validateBody(updateDepartmentSchema), c.update);
router.delete("/:id", requirePermission("department:delete"), c.remove);

export default router;
