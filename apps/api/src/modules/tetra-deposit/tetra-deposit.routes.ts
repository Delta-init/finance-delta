import { Router } from "express";
import { decideTetraDepositSchema, deleteTetraDepositSchema, tetraDepositListQuerySchema, tetraDepositViewSchema } from "@delta/shared";
import { authenticate } from "../../middleware/auth";
import { requireAnyPermission, requirePermission } from "../../middleware/rbac";
import { parseQuery, validateBody } from "../../middleware/validate";
import { asyncHandler, ok } from "../../lib/http";
import {
  decideTetraDeposit, deleteTetraDeposit, getTetraDeposit, listTetraDepositPage, listTetraDeposits, reopenTetraDeposit, resendTetraDeposit,
  restoreTetraDeposit,
} from "./tetra-deposit.service";

/**
 * CS Portal's deposit requests, for whoever decides them (tetra_deposit:approve) and whoever deletes them
 * (tetra_deposit:delete — a Manager or an Administrator, 2026-11-12). Both read the list; each does only their own.
 */
const router = Router();
router.use(authenticate);
router.use(requireAnyPermission("tetra_deposit:approve", "tetra_deposit:delete"));
const approver = requirePermission("tetra_deposit:approve");
const deleter = requirePermission("tetra_deposit:delete");

// The Approvals page's queue. ?view=waiting (default) | attention | decided
router.get("/", asyncHandler(async (req, res) => {
  const view = tetraDepositViewSchema.safeParse(req.query.view);
  ok(res, await listTetraDeposits(req.auth!.organizationId, view.success ? view.data : "waiting"));
}));

// The deposits page: all of them, by status, searched, dated, paged; its CSV
// export reads the same. ?status= all | pending | approved | rejected | closed
router.get("/list", asyncHandler(async (req, res) => {
  const query = parseQuery(tetraDepositListQuerySchema, req.query);
  const { data, meta } = await listTetraDepositPage(req.auth!.organizationId, query);
  ok(res, data, meta);
}));

router.get("/:id", asyncHandler(async (req, res) => {
  ok(res, await getTetraDeposit(req.auth!.organizationId, String(req.params.id)));
}));

router.post("/:id/decision", approver, validateBody(decideTetraDepositSchema), asyncHandler(async (req, res) => {
  ok(res, await decideTetraDeposit(req.auth!, String(req.params.id), req.body));
}));

router.post("/:id/resend", approver, asyncHandler(async (req, res) => {
  ok(res, await resendTetraDeposit(req.auth!, String(req.params.id)));
}));

router.post("/:id/reopen", approver, asyncHandler(async (req, res) => {
  ok(res, await reopenTetraDeposit(req.auth!, String(req.params.id)));
}));

// Taken off the list by hand, with why — kept as "deleted" (2026-10-28); and back again.
router.post("/:id/delete", deleter, validateBody(deleteTetraDepositSchema), asyncHandler(async (req, res) => {
  ok(res, await deleteTetraDeposit(req.auth!, String(req.params.id), req.body));
}));

router.post("/:id/restore", deleter, asyncHandler(async (req, res) => {
  ok(res, await restoreTetraDeposit(req.auth!, String(req.params.id)));
}));

export default router;
