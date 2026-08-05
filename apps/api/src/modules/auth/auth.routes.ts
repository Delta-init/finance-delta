import { Router } from "express";
import { loginSchema, refreshSchema, switchOrgSchema } from "@delta/shared";
import { authenticate } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { rateLimit } from "../../middleware/rateLimit";
import * as authController from "./auth.controller";

const router = Router();

// Throttle login to blunt online brute-force / password-spraying: key on the
// client IP + the email being tried, so a single account or a single source
// gets a 429 after repeated attempts within the window.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) =>
    `${req.ip ?? "ip"}|${String((req.body as { email?: string } | undefined)?.email ?? "").toLowerCase()}`,
  message: "Too many login attempts. Please wait a few minutes and try again.",
});

router.post("/login", loginLimiter, validateBody(loginSchema), authController.login);
router.post("/refresh", validateBody(refreshSchema), authController.refresh);
router.post("/logout", authController.logout);
router.get("/me", authenticate, authController.me);
router.post("/switch-org", authenticate, validateBody(switchOrgSchema), authController.switchOrg);

export default router;
