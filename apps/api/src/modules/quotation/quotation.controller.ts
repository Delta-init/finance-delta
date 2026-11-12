import type { Request, Response } from "express";
import { quotationQuerySchema } from "@delta/shared";
import { asyncHandler, created, ok } from "../../lib/http";
import { parseQuery } from "../../middleware/validate";
import * as quotationService from "./quotation.service";

const orgId = (req: Request) => req.auth!.organizationId;

export const list = asyncHandler(async (req, res) => {
  const query = parseQuery(quotationQuerySchema, req.query);
  const result = await quotationService.listQuotations(orgId(req), query);
  ok(res, result.data, result.meta);
});

export const get = asyncHandler(async (req, res) => {
  ok(res, await quotationService.getQuotation(orgId(req), req.params.id!));
});

export const create = asyncHandler(async (req, res) => {
  created(res, await quotationService.createQuotation(orgId(req), req.body));
});

export const update = asyncHandler(async (req, res) => {
  ok(res, await quotationService.updateQuotation(orgId(req), req.params.id!, req.body));
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  await quotationService.deleteQuotation(orgId(req), req.params.id!);
  res.status(204).end();
});

export const send = asyncHandler(async (req, res) => {
  ok(res, await quotationService.sendQuotation(orgId(req), req.params.id!));
});

export const accept = asyncHandler(async (req, res) => {
  ok(res, await quotationService.acceptQuotation(orgId(req), req.params.id!));
});

export const decline = asyncHandler(async (req, res) => {
  ok(res, await quotationService.declineQuotation(orgId(req), req.params.id!));
});

export const convert = asyncHandler(async (req, res) => {
  ok(res, await quotationService.convertQuotation(orgId(req), req.params.id!, req.body));
});

export const convertInvoice = asyncHandler(async (req, res) => {
  ok(res, await quotationService.convertToInvoice(orgId(req), req.params.id!, req.auth!.userId, req.body));
});
