import { Router } from "express";
import { approvalListQuerySchema } from "@delta/shared";
import { authenticate } from "../../middleware/auth";
import { parseQuery } from "../../middleware/validate";
import { asyncHandler, ok } from "../../lib/http";
import { approvalList, approvalSummary } from "./approvals.service";

const router = Router();
router.use(authenticate);

// What is waiting on the signed-in person, per kind they may decide. No
// permission of its own: it answers with only the kinds the caller is allowed
// to approve, which for most people is none.
router.get("/summary", asyncHandler(async (req, res) => {
  ok(res, await approvalSummary(req.auth!));
}));

// Every approval, waiting and decided, newest first, for the Approvals page's
// table — gated per kind the same way, so nobody sees a kind they cannot decide.
router.get("/list", asyncHandler(async (req, res) => {
  const query = parseQuery(approvalListQuerySchema, req.query);
  const { rows, meta } = await approvalList(req.auth!, query);
  ok(res, rows, meta);
}));

export default router;
