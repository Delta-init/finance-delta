import type { Request, Response } from "express";
import { asyncHandler, created, ok } from "../../lib/http";
import { z } from "zod";
import { listQuerySchema } from "@delta/shared";
import { parseQuery } from "../../middleware/validate";
import * as svc from "./credit-note.service";

const orgId = (req: Request) => req.auth!.organizationId;

export const list = asyncHandler(async (req, res) => {
  // Paged when asked a page (the Credit notes table and its export); the newest 200 otherwise, as before.
  if (req.query.page === undefined) return ok(res, await svc.listCreditNotes(orgId(req)));
  const q = parseQuery(listQuerySchema.extend({ status: z.enum(["draft", "issued", "applied", "voided"]).optional() }), req.query);
  const r = await svc.listCreditNotesPaged(orgId(req), q);
  ok(res, r.data, r.meta);
});
export const get = asyncHandler(async (req, res) => { ok(res, await svc.getCreditNote(orgId(req), req.params.id!)); });
export const create = asyncHandler(async (req, res) => { created(res, await svc.createCreditNote(orgId(req), req.body)); });
export const issue = asyncHandler(async (req: Request, res: Response) => { ok(res, await svc.issueCreditNote(orgId(req), req.params.id!)); });
export const apply = asyncHandler(async (req: Request, res: Response) => { ok(res, await svc.applyCreditNote(orgId(req), req.params.id!, req.body)); });
export const voidNote = asyncHandler(async (req: Request, res: Response) => { ok(res, await svc.voidCreditNote(orgId(req), req.params.id!)); });
