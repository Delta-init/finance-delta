import type { Request } from "express";
import { asyncHandler, ok } from "../../lib/http";
import { getSuggestions } from "./suggestions.service";

const org = (req: Request) => req.auth!.organizationId;

export const suggest = asyncHandler(async (req, res) => {
  const field = String(req.query.field ?? "");
  const q = req.query.q ? String(req.query.q) : "";
  ok(res, await getSuggestions(org(req), field, q));
});
