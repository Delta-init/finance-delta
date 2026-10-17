import { Router } from "express";
import { decideLateEntrySchema, lateEntryQuerySchema } from "@delta/shared";
import { authenticate } from "../../middleware/auth";
import { parseQuery, validateBody } from "../../middleware/validate";
import { asyncHandler, ok } from "../../lib/http";
import { decideLateEntry, lateEntryMe, listLateEntries } from "./late-entry.service";

/*
 * Late entries (2026-10-17). No permission of their own: the Manager tag decides, and the service checks it on every
 * call — /me answers anybody, with isManager false and nothing counted for most people.
 */
const router = Router();
router.use(authenticate);

router.get("/me", asyncHandler(async (req, res) => {
  ok(res, await lateEntryMe(req.auth!.organizationId, req.auth!.userId));
}));

router.get("/", asyncHandler(async (req, res) => {
  ok(res, await listLateEntries(req.auth!.organizationId, req.auth!.userId, parseQuery(lateEntryQuerySchema, req.query)));
}));

router.post("/:id/approve", validateBody(decideLateEntrySchema), asyncHandler(async (req, res) => {
  ok(res, await decideLateEntry(req.auth!.organizationId, req.auth!.userId, req.params.id!, "approved", req.body.note));
}));

router.post("/:id/reject", validateBody(decideLateEntrySchema), asyncHandler(async (req, res) => {
  ok(res, await decideLateEntry(req.auth!.organizationId, req.auth!.userId, req.params.id!, "rejected", req.body.note));
}));

export default router;
