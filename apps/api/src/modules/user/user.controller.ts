import type { Request, Response } from "express";
import { userQuerySchema } from "@delta/shared";
import * as salespeople from "./salespeople.service";
import { asyncHandler, created, ok } from "../../lib/http";
import { parseQuery } from "../../middleware/validate";
import * as userService from "./user.service";
import { inviteUser } from "../auth/password-reset.service";

export const list = asyncHandler(async (req: Request, res: Response) => {
  const query = parseQuery(userQuerySchema, req.query);
  const result = await userService.listUsers(req.auth!.organizationId, query);
  ok(res, result.data, result.meta);
});

/** The flag that grants platform-wide access is checked against who is asking. */
const actorOf = (req: Request) => ({
  userId: req.auth!.userId,
  isSuperAdmin: req.auth!.isSuperAdmin,
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const user = await userService.createUser(req.auth!.organizationId, req.body, actorOf(req));
  created(res, user);
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const user = await userService.updateUser(
    req.auth!.organizationId,
    req.params.id!,
    req.body,
    actorOf(req),
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

/* ── Salespeople (2026-10-20): salespeople.service.ts ── */

export const listSalespeople = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await salespeople.listSalespeople(req.auth!.organizationId, String(req.query.q ?? "")));
});

/** The invite, when asked for, after the account can be signed into — its outcome reported, not hidden. */
async function maybeInvite(orgId: string, userId: string, send: boolean) {
  if (!send) return null;
  const r = await inviteUser(orgId, userId);
  return { ...r, message: r.delivered ? `Invite sent to ${r.email}.` : `Could not send to ${r.email} — check the mail configuration.` };
}

export const convertSalesperson = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.auth!.organizationId;
  const user = await salespeople.convertSalesperson(orgId, req.params.id!, req.body);
  ok(res, { ...user, invite: await maybeInvite(orgId, user.id, !!req.body.sendInvite) });
});

export const createCrmSalesperson = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.auth!.organizationId;
  const user = await salespeople.createFromCrm(orgId, req.body);
  created(res, { ...user, invite: await maybeInvite(orgId, user.id, !!req.body.sendInvite) });
});
