import type { Request } from "express";
import { CRM_COMMISSION_MONTH } from "@delta/shared";
import { AppError, asyncHandler, ok } from "../../lib/http";
import * as svc from "./crm-commission.service";

const org = (req: Request) => req.auth!.organizationId;
const uid = (req: Request) => req.auth!.userId;
const sa = (req: Request) => !!req.auth!.isSuperAdmin;

export const month = asyncHandler(async (req, res) => {
  const m = String(req.query.month ?? "");
  if (!CRM_COMMISSION_MONTH.test(m)) throw new AppError("VALIDATION_ERROR", "month is YYYY-MM");
  ok(res, await svc.crmCommissionMonth(org(req), uid(req), req.auth!.permissions, sa(req), m));
});

export const approve = asyncHandler(async (req, res) => {
  ok(res, await svc.approveCrmCommission(org(req), uid(req), sa(req), req.body));
});

export const revoke = asyncHandler(async (req, res) => {
  ok(res, await svc.revokeCrmCommission(org(req), uid(req), sa(req), req.body));
});

export const upload = asyncHandler(async (req, res) => {
  if (!req.file) throw new AppError("VALIDATION_ERROR", "No file was uploaded");
  ok(res, await svc.uploadReceipt(org(req), req.file));
});

export const pay = asyncHandler(async (req, res) => {
  ok(res, await svc.payCrmCommission(org(req), uid(req), req.body));
});
