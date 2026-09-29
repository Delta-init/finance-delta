import { Router } from "express";
import { decideTetraDepositSchema, tetraDepositViewSchema } from "@delta/shared";
import { authenticate } from "../../middleware/auth";
import { requirePermission } from "../../middleware/rbac";
import { validateBody } from "../../middleware/validate";
import { asyncHandler, ok } from "../../lib/http";
import { decideTetraDeposit, listTetraDeposits, reopenTetraDeposit } from "./tetra-deposit.service";

/**
 * Tetra Commission's deposit requests, for whoever decides them. Everything is
 * behind the one permission: the queue is only read in order to decide it.
 */
const router = Router();
router.use(authenticate);
router.use(requirePermission("tetra_deposit:approve"));

// ?view=waiting (default) | attention | decided
router.get("/", asyncHandler(async (req, res) => {
  const view = tetraDepositViewSchema.safeParse(req.query.view);
  ok(res, await listTetraDeposits(req.auth!.organizationId, view.success ? view.data : "waiting"));
}));

router.post("/:id/decision", validateBody(decideTetraDepositSchema), asyncHandler(async (req, res) => {
  ok(res, await decideTetraDeposit(req.auth!, String(req.params.id), req.body));
}));

router.post("/:id/reopen", asyncHandler(async (req, res) => {
  ok(res, await reopenTetraDeposit(req.auth!, String(req.params.id)));
}));

export default router;
