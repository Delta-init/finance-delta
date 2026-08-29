import type { Request, Response } from "express";
import {
  bankAccountQuerySchema,
  bankTransactionQuerySchema,
} from "@delta/shared";
import { asyncHandler, created, ok } from "../../lib/http";
import { parseQuery } from "../../middleware/validate";
import * as svc from "./banking.service";

const org = (req: Request) => req.auth!.organizationId;
const uid = (req: Request) => req.auth!.userId;

// ── Bank Accounts ─────────────────────────────────────────────────────────────

export const listAccounts = asyncHandler(async (req, res) => {
  const query = parseQuery(bankAccountQuerySchema, req.query);
  const result = await svc.listBankAccounts(org(req), query);
  ok(res, result.data, result.meta);
});

export const getAccount = asyncHandler(async (req, res) => {
  ok(res, await svc.getBankAccount(org(req), req.params.id!));
});

export const createAccount = asyncHandler(async (req, res) => {
  created(res, await svc.createBankAccount(org(req), req.body));
});

export const updateAccount = asyncHandler(async (req, res) => {
  ok(res, await svc.updateBankAccount(org(req), req.params.id!, req.body));
});

export const deactivateAccount = asyncHandler(async (req, res) => {
  ok(res, await svc.deactivateBankAccount(org(req), req.params.id!));
});

// ── Transactions ─────────────────────────────────────────────────────────────

export const listTransactions = asyncHandler(async (req, res) => {
  const query = parseQuery(bankTransactionQuerySchema, req.query);
  const result = await svc.listTransactions(org(req), req.params.id!, query);
  ok(res, result.data, result.meta);
});

export const createTransaction = asyncHandler(async (req, res) => {
  created(res, await svc.addTransaction(org(req), req.params.id!, req.body, "manual"));
});

export const bulkImport = asyncHandler(async (req, res) => {
  const result = await svc.bulkImportTransactions(org(req), req.params.id!, req.body);
  created(res, result);
});

export const getTransaction = asyncHandler(async (req, res) => {
  ok(res, await svc.getTransaction(org(req), req.params.txId!));
});

export const matchTransaction = asyncHandler(async (req, res) => {
  ok(res, await svc.matchTransaction(org(req), req.params.txId!, req.body));
});

export const unmatchTransaction = asyncHandler(async (req, res) => {
  ok(res, await svc.unmatchTransaction(org(req), req.params.txId!));
});

export const updateTransaction = asyncHandler(async (req, res) => {
  ok(res, await svc.updateTransaction(org(req), req.params.id!, req.params.txId!, req.body));
});

export const deleteTransaction = asyncHandler(async (req, res) => {
  await svc.deleteTransaction(org(req), req.params.id!, req.params.txId!);
  res.status(204).end();
});

export const excludeTransaction = asyncHandler(async (req, res) => {
  ok(res, await svc.excludeTransaction(org(req), req.params.txId!));
});

export const restoreTransaction = asyncHandler(async (req, res) => {
  ok(res, await svc.restoreTransaction(org(req), req.params.txId!));
});

export const markDuplicate = asyncHandler(async (req, res) => {
  ok(res, await svc.markDuplicate(org(req), req.params.txId!));
});

// ── Reconciliation ────────────────────────────────────────────────────────────

export const listReconciliations = asyncHandler(async (req, res) => {
  const page = Number(req.query.page) || 1;
  const pageSize = Number(req.query.pageSize) || 10;
  const result = await svc.listReconciliations(org(req), req.params.id!, { page, pageSize });
  ok(res, result.data, result.meta);
});

export const startReconciliation = asyncHandler(async (req, res) => {
  created(res, await svc.startReconciliation(org(req), req.params.id!, req.body));
});

export const getReconciliation = asyncHandler(async (req, res) => {
  ok(res, await svc.getReconciliation(org(req), req.params.sessionId!));
});

export const updateReconciliation = asyncHandler(async (req, res) => {
  ok(res, await svc.updateReconciliation(org(req), req.params.sessionId!, req.body));
});

export const completeReconciliation = asyncHandler(async (req: Request, res: Response) => {
  const user = await import("../user/user.model").then(({ User }) =>
    User.findOne({ _id: uid(req), "memberships.organizationId": org(req) }),
  );
  const completedByName = user?.name ?? "Unknown";
  ok(res, await svc.completeReconciliation(org(req), req.params.sessionId!, completedByName));
});
