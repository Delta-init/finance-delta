import type { Request, Response } from "express";
import { quotationQuerySchema } from "@delta/shared";
import { asyncHandler, created, ok } from "../../lib/http";
import { parseQuery } from "../../middleware/validate";
import { hasPermission } from "@delta/shared";
import * as quotationService from "./quotation.service";

const orgId = (req: Request) => req.auth!.organizationId;
/**
 * An enrolment's quote names a client and a fee, as its invoice does — so it is shown to those who may see every
 * invoice, and not to a salesperson who sees only their own.
 */
const seesEnrolments = (req: Request) => Boolean(req.auth!.isSuperAdmin || hasPermission(req.auth!.permissions, "invoice:read"));

export const list = asyncHandler(async (req, res) => {
  const query = parseQuery(quotationQuerySchema, req.query);
  const result = await quotationService.listQuotations(orgId(req), query, { enrolments: seesEnrolments(req) });
  ok(res, result.data, result.meta);
});

export const get = asyncHandler(async (req, res) => {
  ok(res, await quotationService.getQuotation(orgId(req), req.params.id!, { enrolments: seesEnrolments(req) }));
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
