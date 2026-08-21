import type { Request } from "express";
import { asyncHandler, ok } from "../../lib/http";
import { getSuggestions, getRecentValue } from "./suggestions.service";

const org = (req: Request) => req.auth!.organizationId;

export const suggest = asyncHandler(async (req, res) => {
  const field = String(req.query.field ?? "");
  // ?recent=1&from=invoice → the single most-recently-used value on that doc
  // type (to pre-fill Notes/Terms).
  if (req.query.recent) {
    const from = String(req.query.from ?? "invoice");
    ok(res, await getRecentValue(org(req), field, from));
    return;
  }
  const q = req.query.q ? String(req.query.q) : "";
  ok(res, await getSuggestions(org(req), field, q));
});
