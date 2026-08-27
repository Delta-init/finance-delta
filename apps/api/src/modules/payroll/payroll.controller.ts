import type { Request, Response } from "express";
import { asyncHandler, created, ok } from "../../lib/http";
import { parseQuery } from "../../middleware/validate";
import * as service from "./payroll.service";
import { importPreviewQuerySchema, runQuerySchema } from "./payroll.schemas";

const orgId = (req: Request) => req.auth!.organizationId;

export const listAvailable = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await service.listAvailable(orgId(req)));
});

export const previewImport = asyncHandler(async (req: Request, res: Response) => {
  const { hrmsOrgId, period } = parseQuery(importPreviewQuerySchema, req.query);
  ok(res, await service.previewImport(orgId(req), hrmsOrgId, period));
});

export const importRun = asyncHandler(async (req: Request, res: Response) => {
  const { hrmsOrgId, period } = req.body as { hrmsOrgId: string; period: string };
  created(res, await service.importRun(orgId(req), hrmsOrgId, period, { userId: req.auth!.userId }));
});

export const listRuns = asyncHandler(async (req: Request, res: Response) => {
  const query = parseQuery(runQuerySchema, req.query);
  const result = await service.listRuns(orgId(req), query);
  ok(res, result.data, result.meta);
});

export const getRun = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await service.getRun(orgId(req), req.params.id!));
});

