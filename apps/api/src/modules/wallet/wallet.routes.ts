import { Router } from "express";
import { authenticate } from "../../middleware/auth";
import { AppError, asyncHandler, ok } from "../../lib/http";
import { hrmsClient } from "../../lib/hrms-client";
import { User } from "../user/user.model";

/*
 * My Wallet (2026-11-04: "the wallet on every portal"). HRMS keeps it — salary a day at a time, what came off and
 * why, commission, what finance has paid — and finds the person by the email they sign in here with. Everyone signed
 * in, their own only; the same in every organization they switch to, since it is theirs and not the organization's.
 */
const router = Router();
router.use(authenticate);

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

// GET /wallet?month=YYYY-MM — this month when none is given
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const month = String(req.query.month ?? "");
    if (month && !MONTH.test(month)) throw new AppError("VALIDATION_ERROR", "month must be YYYY-MM");
    if (!hrmsClient.isConfigured()) throw new AppError("UNAVAILABLE", "Finance isn't linked to the HRMS yet, so there is no wallet to show.");
    const user = await User.findById(req.auth!.userId).select("email").lean<{ email?: string } | null>();
    const email = String(user?.email ?? "").trim().toLowerCase();
    if (!email) throw new AppError("VALIDATION_ERROR", "Your account has no email to find your HRMS record with.");
    ok(res, await hrmsClient.wallet(email, month || undefined));
  }),
);

export default router;
