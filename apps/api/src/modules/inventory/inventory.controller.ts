import type { Request, Response } from "express";
import { itemQuerySchema, warehouseQuerySchema, stockMovementQuerySchema } from "@delta/shared";
import { asyncHandler, created, ok } from "../../lib/http";
import { parseQuery } from "../../middleware/validate";
import * as svc from "./inventory.service";

const org = (req: Request) => req.auth!.organizationId;
const uid = (req: Request) => req.auth!.userId;

// ── Items ─────────────────────────────────────────────────────────────────────

export const listItems = asyncHandler(async (req, res) => {
  const query = parseQuery(itemQuerySchema, req.query);
  const result = await svc.listItems(org(req), query);
  ok(res, result.data, result.meta);
});

export const getItem = asyncHandler(async (req, res) => {
  ok(res, await svc.getItem(org(req), req.params.id!));
});

export const createItem = asyncHandler(async (req, res) => {
  created(res, await svc.createItem(org(req), req.body));
});

export const updateItem = asyncHandler(async (req, res) => {
  ok(res, await svc.updateItem(org(req), req.params.id!, req.body));
});

export const deleteItem = asyncHandler(async (req, res) => {
  await svc.deleteItem(org(req), req.params.id!);
  ok(res, { deleted: true });
});

// ── Warehouses ────────────────────────────────────────────────────────────────

export const listWarehouses = asyncHandler(async (req, res) => {
  const query = parseQuery(warehouseQuerySchema, req.query);
  const result = await svc.listWarehouses(org(req), query);
  ok(res, result.data, result.meta);
});

export const getWarehouse = asyncHandler(async (req, res) => {
  ok(res, await svc.getWarehouse(org(req), req.params.whId!));
});

export const createWarehouse = asyncHandler(async (req, res) => {
  created(res, await svc.createWarehouse(org(req), req.body));
});

export const updateWarehouse = asyncHandler(async (req, res) => {
  ok(res, await svc.updateWarehouse(org(req), req.params.whId!, req.body));
});

// ── Stock ─────────────────────────────────────────────────────────────────────

export const getStockLevels = asyncHandler(async (req, res) => {
  ok(res, await svc.getStockLevels(org(req), req.params.id!));
});

export const adjustStock = asyncHandler(async (req: Request, res: Response) => {
  const user = await import("../user/user.model").then(({ User }) =>
    User.findOne({ _id: uid(req), "memberships.organizationId": org(req) }),
  );
  const name = user?.name ?? "Unknown";
  ok(res, await svc.adjustStock(org(req), req.params.id!, req.body, name));
});

export const listMovements = asyncHandler(async (req, res) => {
  const query = parseQuery(stockMovementQuerySchema, req.query);
  const result = await svc.listMovements(org(req), req.params.id!, query);
  ok(res, result.data, result.meta);
});

export const getLowStock = asyncHandler(async (req, res) => {
  ok(res, await svc.getLowStockItems(org(req)));
});

// ── Price Lists ───────────────────────────────────────────────────────────────

export const listPriceLists = asyncHandler(async (req, res) => {
  ok(res, await svc.listPriceLists(org(req)));
});

export const getPriceList = asyncHandler(async (req, res) => {
  ok(res, await svc.getPriceList(org(req), req.params.plId!));
});

export const createPriceList = asyncHandler(async (req, res) => {
  created(res, await svc.createPriceList(org(req), req.body));
});

export const updatePriceList = asyncHandler(async (req, res) => {
  ok(res, await svc.updatePriceList(org(req), req.params.plId!, req.body));
});

export const deletePriceList = asyncHandler(async (req, res) => {
  await svc.deletePriceList(org(req), req.params.plId!);
  ok(res, { deleted: true });
});

// ── Valuation ─────────────────────────────────────────────────────────────────

export const getValuation = asyncHandler(async (req, res) => {
  const currency = (req.query.currency as string) || "AED";
  ok(res, await svc.getValuationReport(org(req), currency));
});
