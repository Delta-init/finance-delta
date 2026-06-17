import type { Request, Response } from "express";
import { userQuerySchema } from "@delta/shared";
import { asyncHandler, created, ok } from "../../lib/http";
import { parseQuery } from "../../middleware/validate";
import * as userService from "./user.service";

export const list = asyncHandler(async (req: Request, res: Response) => {
  const query = parseQuery(userQuerySchema, req.query);
  const result = await userService.listUsers(req.auth!.organizationId, query);
  ok(res, result.data, result.meta);
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const user = await userService.createUser(req.auth!.organizationId, req.body);
  created(res, user);
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const user = await userService.updateUser(
    req.auth!.organizationId,
    req.params.id!,
    req.body,
  );
  ok(res, user);
});
