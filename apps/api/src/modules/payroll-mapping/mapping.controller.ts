import type { Request, Response } from "express";
import { asyncHandler, created, ok } from "../../lib/http";
import { parseQuery } from "../../middleware/validate";
import { hrmsClient } from "../../lib/hrms-client";
import * as service from "./mapping.service";
import { employeeQuerySchema, syncPreviewQuerySchema } from "./mapping.schemas";

const orgId = (req: Request) => req.auth!.organizationId;
// Only the id: the display name is resolved from the User record in the
// service, so an audit trail cannot be shaped by whatever the token claimed.
const actor = (req: Request) => ({ userId: req.auth!.userId });

/** Confirms the credentials and the clock before anyone attempts a real sync. */
export const health = asyncHandler(async (_req: Request, res: Response) => {
  if (!hrmsClient.isConfigured()) {
    ok(res, { configured: false, reachable: false, message: "HRMS integration is not configured on this server" });
    return;
  }
  try {
    const pong = await hrmsClient.ping();
    ok(res, { configured: true, reachable: true, hrmsTime: pong.time });
  } catch (err) {
    ok(res, { configured: true, reachable: false, message: (err as Error).message });
  }
});

export const listHrmsOrganizations = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await service.listHrmsOrganizations(orgId(req)));
});

export const listOrgLinks = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await service.listOrgLinks(orgId(req)));
});

export const createOrgLink = asyncHandler(async (req: Request, res: Response) => {
  created(res, await service.createOrgLink(orgId(req), req.body, actor(req)));
});

export const removeOrgLink = asyncHandler(async (req: Request, res: Response) => {
  await service.removeOrgLink(orgId(req), req.params.id!);
  res.status(204).end();
});

export const previewSync = asyncHandler(async (req: Request, res: Response) => {
  const { hrmsOrgId } = parseQuery(syncPreviewQuerySchema, req.query);
  ok(res, await service.previewSync(orgId(req), hrmsOrgId));
});

export const applySync = asyncHandler(async (req: Request, res: Response) => {
  const { hrmsOrgId, decisions } = req.body as { hrmsOrgId: string; decisions: service.SyncDecision[] };
  ok(res, await service.applySync(orgId(req), hrmsOrgId, decisions, actor(req)));
});

export const listEmployees = asyncHandler(async (req: Request, res: Response) => {
  const query = parseQuery(employeeQuerySchema, req.query);
  const result = await service.listEmployees(orgId(req), query);
  ok(res, result.data, result.meta);
});
