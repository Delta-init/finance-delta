import { Router } from "express";
import { createExpenseCategorySchema, updateExpenseCategorySchema } from "@delta/shared";
import { authenticate } from "../../middleware/auth";
import { requirePermission } from "../../middleware/rbac";
import { validateBody } from "../../middleware/validate";
import * as c from "./expense-category.controller";

const router = Router();
router.use(authenticate);

router.get("/", requirePermission("expense:read"), c.list);
router.post("/", requirePermission("expense:create"), validateBody(createExpenseCategorySchema), c.create);
router.patch("/:id", requirePermission("expense:update"), validateBody(updateExpenseCategorySchema), c.update);
router.delete("/:id", requirePermission("expense:delete"), c.remove);

export default router;
