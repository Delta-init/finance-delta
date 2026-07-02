import type { Request, Response } from "express";
import { asyncHandler, ok } from "../../lib/http";
import * as service from "./dashboard.service";

export const getStats = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await service.getDashboardStats(req.auth!.organizationId, (req.query.currency as string) || undefined));
});
