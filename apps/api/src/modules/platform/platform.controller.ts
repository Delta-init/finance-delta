import type { Request, Response } from "express";
import { asyncHandler, ok, created } from "../../lib/http";
import * as platformService from "./platform.service";

export const listOrgs = asyncHandler(async (_req: Request, res: Response) => {
  ok(res, await platformService.listOrganizations());
});

export const createOrg = asyncHandler(async (req: Request, res: Response) => {
  created(res, await platformService.createOrganization(req.body));
});

export const listMembers = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await platformService.listMembers(req.params.orgId!));
});

export const inviteMember = asyncHandler(async (req: Request, res: Response) => {
  created(res, await platformService.inviteMember(req.params.orgId!, req.body));
});

export const listOrgRoles = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await platformService.listOrgRoles(req.params.orgId!));
});

export const removeMember = asyncHandler(async (req: Request, res: Response) => {
  await platformService.removeMember(req.params.orgId!, req.params.userId!);
  res.status(204).end();
});
