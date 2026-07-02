import type { Request } from "express";
import { asyncHandler, ok, created, AppError } from "../../lib/http";
import { validateBody, parseQuery } from "../../middleware/validate";
import {
  createCommissionStructureSchema,
  updateCommissionStructureSchema,
  markCommissionPaidSchema,
  commissionRecordQuerySchema,
} from "@delta/shared";
import * as svc from "./commission.service";

const org = (req: Request) => req.auth!.organizationId;
const uid = (req: Request) => req.auth!.userId;

// ── Structures ────────────────────────────────────────────────────────────────

export const listStructures = asyncHandler(async (req, res) => {
  ok(res, await svc.listStructures(org(req)));
});

export const getStructure = asyncHandler(async (req, res) => {
  ok(res, await svc.getStructure(org(req), req.params.id!));
});

export const createStructure = asyncHandler(async (req, res) => {
  const input = createCommissionStructureSchema.parse(req.body);
  created(res, await svc.createStructure(org(req), input, uid(req)));
});

export const updateStructure = asyncHandler(async (req, res) => {
  const input = updateCommissionStructureSchema.parse(req.body);
  ok(
    res,
    await svc.updateStructure(org(req), req.params.id!, input, uid(req), req.auth!.permissions),
  );
});

export const lockStructure = asyncHandler(async (req, res) => {
  const actor = await (await import("../user/user.model")).User.findById(uid(req)).lean();
  const actorName = (actor as unknown as { name: string } | null)?.name ?? "Unknown";
  ok(res, await svc.toggleLock(org(req), req.params.id!, true, uid(req), actorName));
});

export const unlockStructure = asyncHandler(async (req, res) => {
  const actor = await (await import("../user/user.model")).User.findById(uid(req)).lean();
  const actorName = (actor as unknown as { name: string } | null)?.name ?? "Unknown";
  ok(res, await svc.toggleLock(org(req), req.params.id!, false, uid(req), actorName));
});

// ── Records ───────────────────────────────────────────────────────────────────

export const listRecords = asyncHandler(async (req, res) => {
  const query = parseQuery(commissionRecordQuerySchema, req.query);
  const result = await svc.listRecords(org(req), query);
  ok(res, result.data, result.meta);
});

export const markPaid = asyncHandler(async (req, res) => {
  const input = markCommissionPaidSchema.parse(req.body);
  ok(res, await svc.markPaid(org(req), input));
});

export const cancelRecord = asyncHandler(async (req, res) => {
  ok(res, await svc.cancelRecord(org(req), req.params.id!));
});

// ── Report ────────────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const commissionReport = asyncHandler(async (req, res) => {
  const now = new Date();
  const from = (req.query.from as string) ?? `${now.getFullYear()}-01-01`;
  const to = (req.query.to as string) ?? now.toISOString().slice(0, 10);
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
    throw new AppError("VALIDATION_ERROR", "from and to must be in YYYY-MM-DD format");
  }
  ok(res, await svc.getCommissionReport(org(req), from, to));
});
