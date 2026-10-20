import type { Request } from "express";
import { AppError, asyncHandler, ok } from "../../lib/http";
import * as svc from "./advances.service";

const org = (req: Request) => req.auth!.organizationId;
const uid = (req: Request) => req.auth!.userId;

export const list = asyncHandler(async (req, res) => {
  ok(res, await svc.listWaiting(org(req)));
});

/** ?status=pending|approved|rejected|all — finance's full record (2026-10-20). */
export const history = asyncHandler(async (req, res) => {
  const status = String(req.query.status ?? "all");
  if (!(svc.ADVANCE_HISTORY_STATUSES as readonly string[]).includes(status)) {
    throw new AppError("VALIDATION_ERROR", `status must be one of ${svc.ADVANCE_HISTORY_STATUSES.join(", ")}`);
  }
  ok(res, await svc.listHistory(org(req), status as (typeof svc.ADVANCE_HISTORY_STATUSES)[number]));
});

export const approve = asyncHandler(async (req, res) => {
  ok(res, await svc.approve(org(req), uid(req), req.params.id!, req.body));
});

export const reject = asyncHandler(async (req, res) => {
  ok(res, await svc.reject(org(req), req.params.id!, req.body));
});
