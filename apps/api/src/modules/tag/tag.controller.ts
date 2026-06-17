import type { Request, Response } from "express";
import { tagQuerySchema } from "@delta/shared";
import { asyncHandler, created, ok } from "../../lib/http";
import { parseQuery } from "../../middleware/validate";
import * as tagService from "./tag.service";

const orgId = (req: Request) => req.auth!.organizationId;

export const list = asyncHandler(async (req: Request, res: Response) => {
  const query = parseQuery(tagQuerySchema, req.query);
  const result = await tagService.listTags(orgId(req), query);
  ok(res, result.data, result.meta);
});

export const listAll = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await tagService.listAllTags(orgId(req)));
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  created(res, await tagService.createTag(orgId(req), req.body));
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await tagService.updateTag(orgId(req), req.params.id!, req.body));
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  await tagService.deleteTag(orgId(req), req.params.id!);
  res.status(204).end();
});
