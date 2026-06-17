import type { Request, Response } from "express";
import { asyncHandler, ok } from "../../lib/http";
import { globalSearch } from "./search.service";

export const search = asyncHandler(async (req: Request, res: Response) => {
  const q = typeof req.query.q === "string" ? req.query.q : "";
  ok(res, await globalSearch(req.auth!.organizationId, q));
});
