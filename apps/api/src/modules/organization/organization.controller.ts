import type { Request, Response } from "express";
import { asyncHandler, ok } from "../../lib/http";
import * as orgService from "./organization.service";

export const getSettings = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await orgService.getOrganization(req.auth!.organizationId));
});

export const updateSettings = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await orgService.updateOrganization(req.auth!.organizationId, req.body));
});

export const getMyOrganizations = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await orgService.getMyOrganizations(req.auth!.userId));
});

export const getTaxConfig = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await orgService.getTaxConfig(req.auth!.organizationId));
});

export const upsertTaxConfig = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await orgService.upsertTaxConfig(req.auth!.organizationId, req.body));
});
