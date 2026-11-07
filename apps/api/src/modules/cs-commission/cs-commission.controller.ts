import type { Request } from "express";
import { CS_COMMISSION_PERIOD, type CsCommissionKind } from "@delta/shared";
import { AppError, asyncHandler, ok } from "../../lib/http";
import * as svc from "./cs-commission.service";

const org = (req: Request) => req.auth!.organizationId;
const uid = (req: Request) => req.auth!.userId;
const sa = (req: Request) => !!req.auth!.isSuperAdmin;

export const period = asyncHandler(async (req, res) => {
  const kind = String(req.query.kind ?? "") as CsCommissionKind;
  const p = String(req.query.period ?? "");
  if (kind !== "bonus" && kind !== "deposit") throw new AppError("VALIDATION_ERROR", "kind is bonus or deposit");
  if (!CS_COMMISSION_PERIOD[kind].test(p)) throw new AppError("VALIDATION_ERROR", kind === "bonus" ? "period is YYYY-MM" : "period is YYYY-Qn");
  ok(res, await svc.csCommissionPeriod(org(req), uid(req), req.auth!.permissions, sa(req), kind, p));
});

export const approve = asyncHandler(async (req, res) => {
  ok(res, await svc.approveCsCommission(org(req), uid(req), sa(req), req.body));
});

export const revoke = asyncHandler(async (req, res) => {
  ok(res, await svc.revokeCsCommission(org(req), uid(req), sa(req), req.body));
});

export const upload = asyncHandler(async (req, res) => {
  if (!req.file) throw new AppError("VALIDATION_ERROR", "No file was uploaded");
  ok(res, await svc.uploadReceipt(org(req), req.file));
});

export const pay = asyncHandler(async (req, res) => {
  ok(res, await svc.payCsCommission(org(req), uid(req), req.body));
});

/** Approve and pay in one step — before the CS Portal's approvals too, with a reason (2026-11-06). */
export const recordPayment = asyncHandler(async (req, res) => {
  ok(res, await svc.recordCsCommissionPayment(org(req), uid(req), sa(req), req.body));
});

/** A Senior/Junior pool split, as the CS Portal's Distribute does (2026-11-07). */
export const splitPool = asyncHandler(async (req, res) => {
  ok(res, await svc.splitCsCommissionPool(org(req), uid(req), sa(req), req.body));
});

/** A credit's course invoice, read-only, for the pop-up (2026-11-07). */
export const invoice = asyncHandler(async (req, res) => {
  ok(res, await svc.csCommissionInvoice(String(req.params.id ?? "")));
});
