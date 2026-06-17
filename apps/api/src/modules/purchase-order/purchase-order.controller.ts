import type { Request, Response } from "express";
import { poQuerySchema } from "@delta/shared";
import { asyncHandler, created, ok } from "../../lib/http";
import { parseQuery } from "../../middleware/validate";
import * as svc from "./purchase-order.service";

const org = (req: Request) => req.auth!.organizationId;

export const list = asyncHandler(async (req, res) => {
  const query = parseQuery(poQuerySchema, req.query);
  const result = await svc.listPOs(org(req), query);
  ok(res, result.data, result.meta);
});

export const get = asyncHandler(async (req, res) => {
  ok(res, await svc.getPO(org(req), req.params.id!));
});

export const create = asyncHandler(async (req, res) => {
  created(res, await svc.createPO(org(req), req.body));
});

export const update = asyncHandler(async (req, res) => {
  ok(res, await svc.updatePO(org(req), req.params.id!, req.body));
});

export const send = asyncHandler(async (req, res) => {
  ok(res, await svc.sendPO(org(req), req.params.id!));
});

export const receive = asyncHandler(async (req, res) => {
  ok(res, await svc.receivePO(org(req), req.params.id!));
});

export const convertToBill = asyncHandler(async (req, res) => {
  created(res, await svc.convertPOToBill(org(req), req.params.id!));
});

export const cancel = asyncHandler(async (req, res) => {
  ok(res, await svc.cancelPO(org(req), req.params.id!));
});
