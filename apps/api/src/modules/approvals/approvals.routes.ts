import { Router } from "express";
import { authenticate } from "../../middleware/auth";
import { asyncHandler, ok } from "../../lib/http";
import { approvalSummary } from "./approvals.service";

const router = Router();
router.use(authenticate);

// What is waiting on the signed-in person, per kind they may decide. No
// permission of its own: it answers with only the kinds the caller is allowed
// to approve, which for most people is none.
router.get("/summary", asyncHandler(async (req, res) => {
  ok(res, await approvalSummary(req.auth!));
}));

export default router;
