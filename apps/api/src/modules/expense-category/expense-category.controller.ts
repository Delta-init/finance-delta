import type { Request } from "express";
import { asyncHandler, created, ok } from "../../lib/http";
import * as svc from "./expense-category.service";

const org = (req: Request) => req.auth!.organizationId;

export const list = asyncHandler(async (req, res) => {
  ok(res, await svc.listCategories(org(req)));
});

export const create = asyncHandler(async (req, res) => {
  created(res, await svc.createCategory(org(req), req.body.name));
});

export const update = asyncHandler(async (req, res) => {
  ok(res, await svc.updateCategory(org(req), req.params.id!, req.body.name));
});

export const remove = asyncHandler(async (req, res) => {
  ok(res, await svc.deleteCategory(org(req), req.params.id!));
});
