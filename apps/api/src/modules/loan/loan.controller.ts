import type { Request } from "express";
import { asyncHandler, ok, created } from "../../lib/http";
import { parseQuery } from "../../middleware/validate";
import {
  createLoanSchema,
  updateLoanSchema,
  recordRepaymentSchema,
  loanQuerySchema,
} from "@delta/shared";
import * as svc from "./loan.service";

const org = (req: Request) => req.auth!.organizationId;
const uid = (req: Request) => req.auth!.userId;

// ── Loans ─────────────────────────────────────────────────────────────────────

export const listLoans = asyncHandler(async (req, res) => {
  const query = parseQuery(loanQuerySchema, req.query);
  const result = await svc.listLoans(org(req), query);
  ok(res, result.data, result.meta);
});

export const getLoan = asyncHandler(async (req, res) => {
  ok(res, await svc.getLoan(org(req), req.params.id!));
});

export const createLoan = asyncHandler(async (req, res) => {
  const input = createLoanSchema.parse(req.body);
  created(res, await svc.createLoan(org(req), input, uid(req)));
});

export const updateLoan = asyncHandler(async (req, res) => {
  const input = updateLoanSchema.parse(req.body);
  ok(res, await svc.updateLoan(org(req), req.params.id!, input));
});

export const deleteLoan = asyncHandler(async (req, res) => {
  await svc.deleteLoan(org(req), req.params.id!);
  res.status(204).end();
});

// ── Repayments ────────────────────────────────────────────────────────────────

export const listRepayments = asyncHandler(async (req, res) => {
  ok(res, await svc.listRepayments(org(req), req.params.id!));
});

export const recordRepayment = asyncHandler(async (req, res) => {
  const input = recordRepaymentSchema.parse(req.body);
  created(res, await svc.recordRepayment(org(req), req.params.id!, input, uid(req)));
});

export const deleteRepayment = asyncHandler(async (req, res) => {
  await svc.deleteRepayment(org(req), req.params.repaymentId!);
  res.status(204).end();
});

// ── Report ────────────────────────────────────────────────────────────────────

export const loanReport = asyncHandler(async (req, res) => {
  ok(res, await svc.getLoanSummaryReport(org(req)));
});
