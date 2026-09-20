import { Router } from "express";
import {
  loginSchema,
  refreshSchema,
  switchOrgSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from "@delta/shared";
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

// Both password-link routes are reachable without a login, so they are
// throttled on the client IP alone — there is no account to key on that the
// caller has proved anything about.
//
// Requesting a reset sends mail to somebody else's address, so an unthrottled
// endpoint is a way to use this system to pester a stranger.
const forgotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => `forgot|${req.ip ?? "ip"}`,
  message: "Too many reset requests. Please wait an hour and try again.",
});

// Spending a link is throttled because the token is the only thing guarding
// it. Guessing one is not feasible, and this makes sure it stays that way.
const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => `reset|${req.ip ?? "ip"}`,
  message: "Too many attempts. Please wait a few minutes and try again.",
});

router.post("/login", loginLimiter, validateBody(loginSchema), authController.login);
// Rate limited like a login, because that is what it is — the credential is
// just a one-time token from the portal rather than a password.
router.post("/sso-login", loginLimiter, authController.ssoLogin);
router.post("/refresh", validateBody(refreshSchema), authController.refresh);
router.post("/forgot-password", forgotLimiter, validateBody(forgotPasswordSchema), authController.forgotPassword);
router.post("/reset-password", resetLimiter, validateBody(resetPasswordSchema), authController.resetPassword);
router.post("/logout", authController.logout);
router.get("/me", authenticate, authController.me);
router.post("/switch-org", authenticate, validateBody(switchOrgSchema), authController.switchOrg);

export default router;
