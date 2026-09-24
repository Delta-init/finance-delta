import type { Request } from "express";
import { hasPermission, budgetQuerySchema, upsertBudgetAllocationSchema, createFundingRequestSchema, reviewFundingRequestSchema } from "@delta/shared";
import { asyncHandler, created, ok } from "../../lib/http";
import { parseQuery } from "../../middleware/validate";
import * as service from "./budget.service";

const org = (req: Request) => req.auth!.organizationId;
const user = (req: Request) => req.auth!.userId;
const seesAll = (req: Request) => req.auth!.isSuperAdmin || hasPermission(req.auth!.permissions, "budget:read") || hasPermission(req.auth!.permissions, "budget:manage") || hasPermission(req.auth!.permissions, "budget:approve");

export const summary = asyncHandler(async (req, res) => {
  const query = parseQuery(budgetQuerySchema, req.query);
  ok(res, await service.getBudgetSummary(org(req), user(req), query, seesAll(req)));
});

export const requests = asyncHandler(async (req, res) => {
  const query = parseQuery(budgetQuerySchema, req.query);
  ok(res, await service.listFundingRequests(org(req), user(req), query, seesAll(req)));
});

export const createRequest = asyncHandler(async (req, res) => {
  const input = createFundingRequestSchema.parse(req.body);
  created(res, await service.createFundingRequest(org(req), user(req), input));
});

export const reviewRequest = asyncHandler(async (req, res) => {
  const input = reviewFundingRequestSchema.parse(req.body);
  ok(res, await service.reviewFundingRequest(org(req), user(req), input, req.params.id!));
});

export const saveAllocation = asyncHandler(async (req, res) => {
  const input = upsertBudgetAllocationSchema.parse(req.body);
  ok(res, await service.upsertAllocation(org(req), user(req), input));
});

export const allocations = asyncHandler(async (req, res) => {
  const query = parseQuery(budgetQuerySchema, req.query);
  const year = query.year ?? new Date().getUTCFullYear();
  ok(res, await service.listAllocations(org(req), year, query.departmentId));
});
