import type { Request } from "express";
import { hasPermission } from "@delta/shared";
import { asyncHandler, ok } from "../../lib/http";
import { importExpenses, previewExpenseImport } from "./expense-import.service";
import { importBills, previewBillImport } from "./bill-import.service";

/*
 * Bills and expenses from a spreadsheet (2026-11-11). Mounted on the bills and expenses routers, behind bill:create and
 * expense:create; the body is already the shared import schema (validateBody).
 */

const org = (req: Request) => req.auth!.organizationId;
const uid = (req: Request) => req.auth!.userId;
/** A vendor not on file is added only for someone who may add vendors. */
const who = (req: Request) => ({ canAddVendors: req.auth!.isSuperAdmin || hasPermission(req.auth!.permissions, "vendor:create") });

export const previewExpenses = asyncHandler(async (req, res) => {
  ok(res, await previewExpenseImport(org(req), req.body));
});

export const runExpenses = asyncHandler(async (req, res) => {
  ok(res, await importExpenses(org(req), uid(req), req.body));
});

export const previewBills = asyncHandler(async (req, res) => {
  ok(res, await previewBillImport(org(req), req.body, who(req)));
});

export const runBills = asyncHandler(async (req, res) => {
  ok(res, await importBills(org(req), uid(req), req.body, who(req)));
});
