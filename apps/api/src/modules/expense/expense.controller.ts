import type { Request, Response } from "express";
import { expenseQuerySchema } from "@delta/shared";
import { asyncHandler, created, ok } from "../../lib/http";
import { parseQuery } from "../../middleware/validate";
import { resolveScope } from "../../lib/ownership";
import * as svc from "./expense.service";

const org = (req: Request) => req.auth!.organizationId;
const uid = (req: Request) => req.auth!.userId;

/**
 * Whose expenses this caller may touch. `expense:read` is org-wide; somebody
 * holding only `expense:read:own` sees their own claims and nothing else.
 */
const readScope = (req: Request) => resolveScope(req.auth!, "expense:read", "expense:read:own");
const writeScope = (req: Request) => resolveScope(req.auth!, "expense:update", "expense:write:own");

export const list = asyncHandler(async (req, res) => {
  const query = parseQuery(expenseQuerySchema, req.query);
  const result = await svc.listExpenses(org(req), query, readScope(req));
  ok(res, result.data, result.meta);
});

export const get = asyncHandler(async (req, res) => {
  ok(res, await svc.getExpense(org(req), req.params.id!, readScope(req)));
});

export const create = asyncHandler(async (req, res) => {
  created(res, await svc.createExpense(org(req), uid(req), req.body));
});

export const update = asyncHandler(async (req, res) => {
  ok(res, await svc.updateExpense(org(req), req.params.id!, req.body, writeScope(req)));
});

export const submit = asyncHandler(async (req, res) => {
  ok(res, await svc.submitExpense(org(req), req.params.id!, writeScope(req)));
});

export const approve = asyncHandler(async (req: Request, res: Response) => {
  const user = await import("../user/user.model").then(({ User }) =>
    User.findOne({ _id: uid(req), "memberships.organizationId": org(req) }),
  );
  const approverName = user?.name ?? "Unknown";
  ok(res, await svc.approveExpense(org(req), req.params.id!, uid(req), approverName));
});

export const reject = asyncHandler(async (req: Request, res: Response) => {
  const user = await import("../user/user.model").then(({ User }) =>
    User.findOne({ _id: uid(req), "memberships.organizationId": org(req) }),
  );
  const approverName = user?.name ?? "Unknown";
  ok(res, await svc.rejectExpense(org(req), req.params.id!, uid(req), approverName, req.body));
});

export const voidExpense = asyncHandler(async (req, res) => {
  ok(res, await svc.voidExpense(org(req), req.params.id!));
});

export const pauseRecurrence = asyncHandler(async (req, res) => {
  ok(res, await svc.setRecurrenceActive(org(req), req.params.id!, false));
});

export const resumeRecurrence = asyncHandler(async (req, res) => {
  ok(res, await svc.setRecurrenceActive(org(req), req.params.id!, true));
});

export const stopRecurrence = asyncHandler(async (req, res) => {
  ok(res, await svc.stopRecurrence(org(req), req.params.id!));
});
