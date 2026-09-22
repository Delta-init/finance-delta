import type { Request } from "express";
import { asyncHandler, ok } from "../../lib/http";
import * as svc from "./procurement.service";

const org = (req: Request) => req.auth!.organizationId;

export const list = asyncHandler(async (req, res) => {
  ok(res, await svc.listWaiting(org(req)));
});

export const approve = asyncHandler(async (req, res) => {
  const { hrmsOrgId, vendorId, note } = req.body ?? {};
  ok(res, await svc.approve(org(req), { hrmsOrgId, requestId: req.params.id!, vendorId, note }));
});

export const reject = asyncHandler(async (req, res) => {
  const { hrmsOrgId, note } = req.body ?? {};
  ok(res, await svc.reject(org(req), { hrmsOrgId, requestId: req.params.id!, note }));
});
