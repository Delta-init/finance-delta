import type { Request } from "express";
import { asyncHandler, ok } from "../../lib/http";
import * as svc from "./procurement.service";

const org = (req: Request) => req.auth!.organizationId;
const uid = (req: Request) => req.auth!.userId;

export const list = asyncHandler(async (req, res) => {
  ok(res, await svc.listWaiting(org(req)));
});

export const approve = asyncHandler(async (req, res) => {
  ok(res, await svc.approve(org(req), uid(req), req.params.id!, req.body));
});

export const reject = asyncHandler(async (req, res) => {
  ok(res, await svc.reject(org(req), req.params.id!, req.body));
});
