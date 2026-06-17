import type { Request, Response } from "express";
import { salesOrderQuerySchema } from "@delta/shared";
import { asyncHandler, ok } from "../../lib/http";
import { parseQuery } from "../../middleware/validate";
import * as salesOrderService from "./salesorder.service";

const orgId = (req: Request) => req.auth!.organizationId;

export const list = asyncHandler(async (req, res) => {
  const query = parseQuery(salesOrderQuerySchema, req.query);
  const result = await salesOrderService.listSalesOrders(orgId(req), query);
  ok(res, result.data, result.meta);
});

export const get = asyncHandler(async (req, res) => {
  ok(res, await salesOrderService.getSalesOrder(orgId(req), req.params.id!));
});

export const cancel = asyncHandler(async (req, res) => {
  ok(res, await salesOrderService.cancelSalesOrder(orgId(req), req.params.id!));
});
