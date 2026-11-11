import { Router } from "express";
import { recordTdsPaymentSchema, tdsReportQuerySchema, updateTdsConfigSchema } from "@delta/shared";
import { authenticate } from "../../middleware/auth";
import { requirePermission } from "../../middleware/rbac";
import { parseQuery, validateBody } from "../../middleware/validate";
import { asyncHandler, created, ok } from "../../lib/http";
import { deleteTdsPayment, recordTdsPayment, tdsConfig, tdsReport, updateTdsConfig } from "./tds.service";

/* TDS on vendor bills — Bangalore (INR books) only (2026-11-11). */
const router = Router();
router.use(authenticate);
const org = (req: { auth?: { organizationId: string } }) => req.auth!.organizationId;

router.get("/config", requirePermission("bill:read"), asyncHandler(async (req, res) => { ok(res, await tdsConfig(org(req))); }));
router.patch("/config", requirePermission("organization:update"), validateBody(updateTdsConfigSchema), asyncHandler(async (req, res) => {
  ok(res, await updateTdsConfig(org(req), req.body));
}));
router.get("/report", requirePermission("bill:read"), asyncHandler(async (req, res) => {
  ok(res, await tdsReport(org(req), parseQuery(tdsReportQuerySchema, req.query)));
}));
router.post("/payments", requirePermission("banking:write"), validateBody(recordTdsPaymentSchema), asyncHandler(async (req, res) => {
  created(res, await recordTdsPayment(org(req), req.body, req.auth!.userId));
}));
router.delete("/payments/:id", requirePermission("banking:write"), asyncHandler(async (req, res) => {
  await deleteTdsPayment(org(req), req.params.id!);
  ok(res, { deleted: true });
}));

export default router;
