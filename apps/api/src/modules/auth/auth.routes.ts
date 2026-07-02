import { Router } from "express";
import { loginSchema, refreshSchema, switchOrgSchema } from "@delta/shared";
import { authenticate } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import * as authController from "./auth.controller";

const router = Router();

router.post("/login", validateBody(loginSchema), authController.login);
router.post("/refresh", validateBody(refreshSchema), authController.refresh);
router.post("/logout", authController.logout);
router.get("/me", authenticate, authController.me);
router.post("/switch-org", authenticate, validateBody(switchOrgSchema), authController.switchOrg);

export default router;
