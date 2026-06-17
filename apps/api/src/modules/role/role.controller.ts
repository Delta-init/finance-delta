import type { Request, Response } from "express";
import { roleQuerySchema } from "@delta/shared";
import { asyncHandler, created, ok } from "../../lib/http";
import { parseQuery } from "../../middleware/validate";
import * as roleService from "./role.service";

export const list = asyncHandler(async (req: Request, res: Response) => {
  const query = parseQuery(roleQuerySchema, req.query);
  const result = await roleService.listRoles(req.auth!.organizationId, query);
  ok(res, result.data, result.meta);
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const role = await roleService.createRole(req.auth!.organizationId, req.body);
  created(res, role);
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const role = await roleService.updateRole(
    req.auth!.organizationId,
    req.params.id!,
    req.body,
  );
  ok(res, role);
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  await roleService.deleteRole(req.auth!.organizationId, req.params.id!);
  res.status(204).end();
});
