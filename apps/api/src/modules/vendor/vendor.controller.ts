import type { Request, Response } from "express";
import { vendorQuerySchema } from "@delta/shared";
import { asyncHandler, created, ok } from "../../lib/http";
import { parseQuery } from "../../middleware/validate";
import * as svc from "./vendor.service";

export const list = asyncHandler(async (req: Request, res: Response) => {
  const query = parseQuery(vendorQuerySchema, req.query);
  const result = await svc.listVendors(req.auth!.organizationId, query);
  ok(res, result.data, result.meta);
});

export const get = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await svc.getVendor(req.auth!.organizationId, req.params.id!));
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  created(res, await svc.createVendor(req.auth!.organizationId, req.body));
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await svc.updateVendor(req.auth!.organizationId, req.params.id!, req.body));
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  await svc.deleteVendor(req.auth!.organizationId, req.params.id!);
  res.status(204).end();
});
