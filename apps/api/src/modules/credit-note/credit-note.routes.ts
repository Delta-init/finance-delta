import { Router } from "express";
import { createCreditNoteSchema, applyCreditNoteSchema } from "@delta/shared";
import { authenticate } from "../../middleware/auth";
import { requirePermission } from "../../middleware/rbac";
import { validateBody } from "../../middleware/validate";
import * as c from "./credit-note.controller";

const router = Router();
router.use(authenticate);

router.get("/", requirePermission("invoice:read"), c.list);
router.get("/:id", requirePermission("invoice:read"), c.get);
router.post("/", requirePermission("invoice:write"), validateBody(createCreditNoteSchema), c.create);
router.post("/:id/issue", requirePermission("invoice:write"), c.issue);
router.post("/:id/apply", requirePermission("invoice:write"), validateBody(applyCreditNoteSchema), c.apply);
router.post("/:id/void", requirePermission("invoice:write"), c.voidNote);

export default router;
