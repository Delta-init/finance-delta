import type { Request, Response } from "express";
import { asyncHandler, created, ok } from "../../lib/http";
import { parseQuery } from "../../middleware/validate";
import * as service from "./payroll.service";
import * as adjustments from "./adjustments.service";
import * as payments from "./payment.service";
import * as peopleReport from "./people-report.service";
import * as manual from "./manual.service";
import {
  importPreviewQuerySchema, runQuerySchema,
  peopleReportQuerySchema, personDetailQuerySchema, personLedgerQuerySchema,
} from "./payroll.schemas";

const orgId = (req: Request) => req.auth!.organizationId;

export const listAvailable = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await service.listAvailable(orgId(req)));
});

export const previewImport = asyncHandler(async (req: Request, res: Response) => {
  const { hrmsOrgId, period } = parseQuery(importPreviewQuerySchema, req.query);
  ok(res, await service.previewImport(orgId(req), hrmsOrgId, period));
});

export const importRun = asyncHandler(async (req: Request, res: Response) => {
  const { hrmsOrgId, period } = req.body as { hrmsOrgId: string; period: string };
  created(res, await service.importRun(orgId(req), hrmsOrgId, period, { userId: req.auth!.userId }));
});

export const listRuns = asyncHandler(async (req: Request, res: Response) => {
  const query = parseQuery(runQuerySchema, req.query);
  const result = await service.listRuns(orgId(req), query);
  ok(res, result.data, result.meta);
});

export const getRun = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await service.getRun(orgId(req), req.params.id!));
});

export const addAdjustments = asyncHandler(async (req: Request, res: Response) => {
  const { items } = req.body as { items: adjustments.AddAdjustmentInput[] };
  ok(res, await adjustments.addAdjustments(orgId(req), req.params.id!, items, { userId: req.auth!.userId }));
});

/** The CS Portal's approved commission, on its own button (2026-11-06) — before or after approval. */
export const pullCsCommission = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await adjustments.pullCsCommission(orgId(req), req.params.id!, { userId: req.auth!.userId }));
});

export const pullCommissions = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await adjustments.pullCommissions(orgId(req), req.params.id!, { userId: req.auth!.userId }));
});

export const pullSlabSalaries = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await adjustments.pullSlabSalaries(orgId(req), req.params.id!, { userId: req.auth!.userId }));
});

export const removeAdjustment = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await adjustments.removeAdjustment(orgId(req), req.params.id!, req.params.externalId!));
});

export const approveRun = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await payments.approveRun(orgId(req), req.params.id!, { userId: req.auth!.userId }));
});

export const unapproveRun = asyncHandler(async (req: Request, res: Response) => {
  const reason = String((req.body as { reason?: unknown } | undefined)?.reason ?? "").trim().slice(0, 300) || "Approved by mistake";
  ok(res, await payments.unapproveRun(orgId(req), req.params.id!, reason));
});

export const holdLine = asyncHandler(async (req: Request, res: Response) => {
  const body = req.body as { hold: boolean; reason?: string };
  ok(res, await payments.setLineHold(orgId(req), req.params.id!, req.params.lineId!, body, { userId: req.auth!.userId }));
});

export const returnRun = asyncHandler(async (req: Request, res: Response) => {
  const { reason } = req.body as { reason: string };
  ok(res, await payments.returnRun(orgId(req), req.params.id!, reason));
});

export const payRun = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await payments.payRun(orgId(req), req.params.id!, req.body as payments.PayInput, { userId: req.auth!.userId }));
});

export const retrySync = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await payments.retrySync(orgId(req), req.params.id!, req.params.paymentId!));
});

export const reversePayment = asyncHandler(async (req: Request, res: Response) => {
  const { reason } = req.body as { reason: string };
  ok(res, await payments.reversePayment(orgId(req), req.params.id!, req.params.paymentId!, reason));
});

export const reconciliation = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await service.reconciliation(orgId(req)));
});

// ── People: what each person earned, and what they cost ─────────────────────

export const peopleReport_ = asyncHandler(async (req: Request, res: Response) => {
  const query = parseQuery(peopleReportQuerySchema, req.query);
  ok(res, await peopleReport.peopleReport(orgId(req), query, { withLogins: true }));
});

export const personLedger = asyncHandler(async (req: Request, res: Response) => {
  const query = parseQuery(personLedgerQuerySchema, req.query);
  ok(res, await peopleReport.personLedger(orgId(req), req.params.employeeId!, query));
});

export const personDetail = asyncHandler(async (req: Request, res: Response) => {
  const query = parseQuery(personDetailQuerySchema, req.query);
  ok(res, await peopleReport.personDetail(orgId(req), req.params.employeeId!, query));
});

export const departmentReport = asyncHandler(async (req: Request, res: Response) => {
  const query = parseQuery(personDetailQuerySchema, req.query);
  ok(res, await peopleReport.departmentReport(orgId(req), query));
});

// ── Manual payroll (2026-11-11) ──────────────────────────────────────────────

/** Where this organization's months come from, for the payroll pages (no settings permission needed to know). */
export const payrollSetup = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await manual.payrollSetup(orgId(req)));
});

export const createManualRun = asyncHandler(async (req: Request, res: Response) => {
  created(res, await manual.createManualRun(orgId(req), req.body as manual.CreateManualRunInput, { userId: req.auth!.userId }));
});

export const addManualLines = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await manual.addManualLines(orgId(req), req.params.id!, req.body as Parameters<typeof manual.addManualLines>[2]));
});

export const updateManualLine = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await manual.updateManualLine(orgId(req), req.params.id!, req.params.lineId!, req.body as Parameters<typeof manual.updateManualLine>[3]));
});

export const removeManualLine = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await manual.removeManualLine(orgId(req), req.params.id!, req.params.lineId!));
});

export const deleteManualRun = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await manual.deleteManualRun(orgId(req), req.params.id!));
});
