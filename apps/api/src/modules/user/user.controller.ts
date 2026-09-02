import type { Request, Response } from "express";
import { userQuerySchema } from "@delta/shared";
import { asyncHandler, created, ok } from "../../lib/http";
import { parseQuery } from "../../middleware/validate";
import * as userService from "./user.service";
import { inviteUser } from "../auth/password-reset.service";

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

/**
 * Send somebody a link to set their first password.
 *
 * Unlike a reset, this reports what happened: the administrator asking is
 * looking at the account, so there is nothing to conceal from them — and an
 * invite that quietly failed to send is worse than one that says so.
 */
export const invite = asyncHandler(async (req: Request, res: Response) => {
  const result = await inviteUser(req.auth!.organizationId, req.params.id!);
  ok(res, {
    ...result,
    message: result.delivered
      ? `Invite sent to ${result.email}.`
      : `Could not send to ${result.email} — check the mail configuration.`,
  });
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  await userService.removeUser(req.auth!.organizationId, req.params.id!, req.auth!.userId);
  res.status(204).end();
});

export const colleagues = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await userService.listColleagues(req.auth!.organizationId));
});
