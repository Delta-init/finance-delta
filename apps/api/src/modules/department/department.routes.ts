import { Router } from "express";
import { createDepartmentSchema, updateDepartmentSchema } from "@delta/shared";
import { authenticate } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import * as c from "./department.controller";

const router = Router();
router.use(authenticate);

router.get("/", c.list);
router.get("/all", c.listAll);
router.post("/", validateBody(createDepartmentSchema), c.create);
router.patch("/:id", validateBody(updateDepartmentSchema), c.update);
router.delete("/:id", c.remove);

export default router;
