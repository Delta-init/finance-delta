import type { Request, Response } from "express";
import { vendorCreditQuerySchema } from "@delta/shared";
import { asyncHandler, created, ok } from "../../lib/http";
import { parseQuery } from "../../middleware/validate";
import * as svc from "./vendor-credit.service";

const org = (req: Request) => req.auth!.organizationId;

export const list = asyncHandler(async (req, res) => {
  const query = parseQuery(vendorCreditQuerySchema, req.query);
  const result = await svc.listVendorCredits(org(req), query);
  ok(res, result.data, result.meta);
});

export const get = asyncHandler(async (req, res) => {
  ok(res, await svc.getVendorCredit(org(req), req.params.id!));
});

export const create = asyncHandler(async (req, res) => {
  created(res, await svc.createVendorCredit(org(req), req.body));
});

export const issue = asyncHandler(async (req, res) => {
  ok(res, await svc.issueVendorCredit(org(req), req.params.id!));
});

export const apply = asyncHandler(async (req, res) => {
  ok(res, await svc.applyVendorCredit(org(req), req.params.id!, req.body));
});

export const voidCredit = asyncHandler(async (req, res) => {
  ok(res, await svc.voidVendorCredit(org(req), req.params.id!));
});
