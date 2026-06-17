import { Router } from "express";
import { createTagSchema, updateTagSchema } from "@delta/shared";
import { authenticate } from "../../middleware/auth";
import { requirePermission } from "../../middleware/rbac";
import { validateBody } from "../../middleware/validate";
import * as c from "./tag.controller";

const router = Router();
router.use(authenticate);

router.get("/", requirePermission("tag:read"), c.list);
router.get("/all", requirePermission("tag:read"), c.listAll);
router.post("/", requirePermission("tag:create"), validateBody(createTagSchema), c.create);
router.patch("/:id", requirePermission("tag:update"), validateBody(updateTagSchema), c.update);
router.delete("/:id", requirePermission("tag:delete"), c.remove);

export default router;
