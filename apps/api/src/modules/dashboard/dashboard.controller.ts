import type { Request, Response } from "express";
import { DASHBOARD_BREAKDOWN_KINDS, hasPermission, type DashboardBreakdownKind } from "@delta/shared";
import { AppError, asyncHandler, ok } from "../../lib/http";
import * as service from "./dashboard.service";

export const getStats = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await service.getDashboardStats(req.auth!.organizationId, (req.query.currency as string) || undefined));
});

/**
 * Where a dashboard figure came from (2026-10-26). The overview's totals are open to report:read or invoice:read, as
 * the dashboard is; the records behind an expense, bill or payables figure need report:read or expense:read — a
 * salesperson, who sees the dashboard through invoice:read, sees the invoices behind it but not the expenses.
 */
export const getBreakdown = asyncHandler(async (req: Request, res: Response) => {
  const str = (k: string) => (typeof req.query[k] === "string" ? (req.query[k] as string) : undefined);
  const kind = str("kind") as DashboardBreakdownKind | undefined;
  if (!kind || !DASHBOARD_BREAKDOWN_KINDS.includes(kind)) throw new AppError("VALIDATION_ERROR", `kind must be one of ${DASHBOARD_BREAKDOWN_KINDS.join(", ")}`);
  const auth = req.auth!;
  if (service.EXPENSE_BREAKDOWNS.includes(kind) && !auth.isSuperAdmin
    && !hasPermission(auth.permissions, "report:read") && !hasPermission(auth.permissions, "expense:read")) {
    throw new AppError("FORBIDDEN", "Missing required permission: report:read or expense:read");
  }
  ok(res, await service.getDashboardBreakdown(auth.organizationId, { kind, month: str("month"), band: str("band"), category: str("category"), customer: str("customer") }));
});
