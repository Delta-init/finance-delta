import type { Request, Response } from "express";
import { departmentQuerySchema } from "@delta/shared";
import { asyncHandler, created, ok } from "../../lib/http";
import { parseQuery } from "../../middleware/validate";
import * as departmentService from "./department.service";

const orgId = (req: Request) => req.auth!.organizationId;

export const list = asyncHandler(async (req: Request, res: Response) => {
  const query = parseQuery(departmentQuerySchema, req.query);
  const result = await departmentService.listDepartments(orgId(req), query);
  ok(res, result.data, result.meta);
});

export const listAll = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await departmentService.listAllDepartments(orgId(req)));
});

/** Admin → Departments → Sync from HRMS (2026-11-05). */
export const syncHrms = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await departmentService.syncFromHrms(orgId(req), req.auth!.userId));
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  created(res, await departmentService.createDepartment(orgId(req), req.body));
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await departmentService.updateDepartment(orgId(req), req.params.id!, req.body));
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  await departmentService.deleteDepartment(orgId(req), req.params.id!);
  res.status(204).end();
});
