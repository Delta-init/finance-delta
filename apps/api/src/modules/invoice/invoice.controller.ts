import type { Request, Response } from "express";
import { invoiceQuerySchema } from "@delta/shared";
import { asyncHandler, created, ok } from "../../lib/http";
import { parseQuery } from "../../middleware/validate";
import * as invoiceService from "./invoice.service";

const orgId = (req: Request) => req.auth!.organizationId;

export const list = asyncHandler(async (req, res) => {
  const query = parseQuery(invoiceQuerySchema, req.query);
  const result = await invoiceService.listInvoices(orgId(req), query);
  ok(res, result.data, result.meta);
});

export const get = asyncHandler(async (req, res) => {
  ok(res, await invoiceService.getInvoice(orgId(req), req.params.id!));
});

export const create = asyncHandler(async (req, res) => {
  created(res, await invoiceService.createInvoice(orgId(req), req.body));
});

export const update = asyncHandler(async (req, res) => {
  ok(res, await invoiceService.updateInvoice(orgId(req), req.params.id!, req.body));
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  await invoiceService.deleteInvoice(orgId(req), req.params.id!);
  res.status(204).end();
});

export const send = asyncHandler(async (req, res) => {
  ok(res, await invoiceService.sendInvoice(orgId(req), req.params.id!));
});

export const voidInvoice = asyncHandler(async (req, res) => {
  ok(res, await invoiceService.voidInvoice(orgId(req), req.params.id!));
});

export const recordPayment = asyncHandler(async (req, res) => {
  created(res, await invoiceService.recordPayment(orgId(req), req.params.id!, req.body));
});

export const resend = asyncHandler(async (req, res) => {
  await invoiceService.resendInvoice(orgId(req), req.params.id!, req.body?.message);
  ok(res, { queued: true });
});
