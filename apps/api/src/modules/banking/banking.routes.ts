import { Router } from "express";
import {
  createBankAccountSchema,
  updateBankAccountSchema,
  createBankTransactionSchema,
  updateBankTransactionSchema,
  bulkImportTransactionsSchema,
  previewImportSchema,
  bulkDeleteTransactionsSchema,
  matchExpenseSchema,
  matchTransactionSchema,
  cashCountSchema,
  updateCashCountSchema,
  startReconciliationSchema,
  updateReconciliationSchema,
  editReconciliationSchema,
  createTransferSchema,
  updateTransferSchema,
  createPspSettlementSchema,
  checkStatementSchema,
  addStatementLineSchema,
} from "@delta/shared";
import { authenticate } from "../../middleware/auth";
import { requirePermission } from "../../middleware/rbac";
import { parseUpload, parseStatementUpload } from "../../middleware/upload";
import { validateBody } from "../../middleware/validate";
import * as c from "./banking.controller";
import * as psp from "../psp-settlement/psp-settlement.controller";

const router = Router();
router.use(authenticate);

// Transfers between the organization's own accounts (2026-10-22) — before "/:id", whose patterns they would meet.
router.post("/transfers", requirePermission("banking:write"), validateBody(createTransferSchema), c.createTransfer);
router.patch("/transfers/:transferId", requirePermission("banking:write"), validateBody(updateTransferSchema), c.updateTransfer);
router.delete("/transfers/:transferId", requirePermission("banking:write"), c.deleteTransfer);

// Bank accounts
router.get("/", requirePermission("banking:read"), c.listAccounts);
// Every PSP account's unsettled money, for the dashboard (2026-11-06) — before "/:id".
router.get("/psp/summary", requirePermission("banking:read"), psp.allSummaries);
router.get("/:id", requirePermission("banking:read"), c.getAccount);
// A PSP account's settlements (2026-11-06): what waits to be settled, and each settlement — the transfer and fee it made.
router.get("/:id/psp/unsettled", requirePermission("banking:read"), psp.unsettled);
router.get("/:id/psp/summary", requirePermission("banking:read"), psp.summary);
router.get("/:id/psp/settlements", requirePermission("banking:read"), psp.list);
router.post("/:id/psp/settlements", requirePermission("banking:write"), validateBody(createPspSettlementSchema), psp.create);
router.delete("/:id/psp/settlements/:settlementId", requirePermission("banking:write"), psp.remove);
router.post("/", requirePermission("banking:write"), validateBody(createBankAccountSchema), c.createAccount);
router.patch("/:id", requirePermission("banking:write"), validateBody(updateBankAccountSchema), c.updateAccount);
router.post("/:id/deactivate", requirePermission("banking:write"), c.deactivateAccount);

// Transactions
router.get("/:id/transactions", requirePermission("banking:read"), c.listTransactions);
router.post("/:id/transactions", requirePermission("banking:write"), validateBody(createBankTransactionSchema), c.createTransaction);
router.post("/:id/transactions/bulk", requirePermission("banking:write"), validateBody(bulkImportTransactionsSchema), c.bulkImport);
// Reads only — it reports which lines are already on the account and writes
// nothing, so it needs no more than the write permission the import itself has.
// Several lines deleted at once (2026-11-11), each by the rules of a single delete.
router.post("/:id/transactions/bulk-delete", requirePermission("banking:write"), validateBody(bulkDeleteTransactionsSchema), c.bulkDelete);
router.post("/:id/transactions/import-preview", requirePermission("banking:write"), validateBody(previewImportSchema), c.previewImport);
router.get("/:id/transactions/:txId", requirePermission("banking:read"), c.getTransaction);
// Correcting or removing an entry. Refused once it has been reconciled or
// matched to a document — see assertEditable in the service.
router.patch("/:id/transactions/:txId", requirePermission("banking:write"), validateBody(updateBankTransactionSchema), c.updateTransaction);
router.delete("/:id/transactions/:txId", requirePermission("banking:write"), c.deleteTransaction);
// The receipt behind an entry. Same permission as changing the entry itself.
router.post(
  "/:id/transactions/:txId/attachments",
  requirePermission("banking:write"),
  parseUpload,
  c.addTransactionAttachment,
);
router.delete(
  "/:id/transactions/:txId/attachments/:key(*)",
  requirePermission("banking:write"),
  c.removeTransactionAttachment,
);
router.post("/:id/transactions/:txId/match", requirePermission("banking:write"), validateBody(matchTransactionSchema), c.matchTransaction);
// Matched to an expense only (2026-11-11): the expenses it could be, and the match itself (the expense paid through it).
router.get("/:id/transactions/:txId/expense-candidates", requirePermission("banking:read"), c.expenseCandidates);
router.post("/:id/transactions/:txId/match-expense", requirePermission("banking:write"), validateBody(matchExpenseSchema), c.matchToExpense);
router.post("/:id/transactions/:txId/unmatch", requirePermission("banking:write"), c.unmatchTransaction);
router.post("/:id/transactions/:txId/exclude", requirePermission("banking:write"), c.excludeTransaction);
router.post("/:id/transactions/:txId/duplicate", requirePermission("banking:write"), c.markDuplicate);
// The way back from either. Excluding and flagging a duplicate were both
// one-way, so a row marked in error stayed marked.
router.post("/:id/transactions/:txId/restore", requirePermission("banking:write"), c.restoreTransaction);

// Reconciliation
router.get("/:id/reconciliations", requirePermission("banking:read"), c.listReconciliations);
router.post("/:id/reconciliations", requirePermission("banking:reconcile"), validateBody(startReconciliationSchema), c.startReconciliation);
// A period's opening balance, and a session's lines to tick (2026-10-23) — before /:sessionId.
router.get("/:id/reconciliations/opening", requirePermission("banking:read"), c.getReconciliationOpening);
router.get("/:id/reconciliations/:sessionId/lines", requirePermission("banking:read"), c.getReconciliationLines);
router.get("/:id/reconciliations/:sessionId", requirePermission("banking:read"), c.getReconciliation);
router.patch("/:id/reconciliations/:sessionId", requirePermission("banking:reconcile"), validateBody(updateReconciliationSchema), c.updateReconciliation);
router.post("/:id/reconciliations/:sessionId/complete", requirePermission("banking:reconcile"), c.completeReconciliation);
// Reconciling by uploading the statement (2026-11-07).
router.post("/:id/reconciliations/:sessionId/statement/file", requirePermission("banking:reconcile"), parseStatementUpload, c.uploadStatementFile);
router.post("/:id/reconciliations/:sessionId/statement/check", requirePermission("banking:reconcile"), validateBody(checkStatementSchema), c.checkStatement);
router.post("/:id/reconciliations/:sessionId/statement/lines/:index/charge", requirePermission("banking:reconcile"), c.recordStatementDifference);
router.post("/:id/reconciliations/:sessionId/statement/lines/:index/add", requirePermission("banking:reconcile"), validateBody(addStatementLineSchema), c.addStatementLine);
router.patch("/:id/reconciliations/:sessionId/details", requirePermission("banking:reconcile"), validateBody(editReconciliationSchema), c.editReconciliation);
router.post("/:id/reconciliations/:sessionId/reopen", requirePermission("banking:reconcile"), c.reopenReconciliation);
router.delete("/:id/reconciliations/:sessionId", requirePermission("banking:reconcile"), c.deleteReconciliation);
// Counting a tin, which settles it in one go rather than line by line.
router.post("/:id/cash-count", requirePermission("banking:reconcile"), validateBody(cashCountSchema), c.recordCashCount);
// Correcting or withdrawing one. A count locks the entries it covered, so
// withdrawing it is the only way back to a row that needs fixing.
router.patch("/:id/cash-count/:sessionId", requirePermission("banking:reconcile"), validateBody(updateCashCountSchema), c.updateCashCount);
router.delete("/:id/cash-count/:sessionId", requirePermission("banking:reconcile"), c.deleteCashCount);

export default router;
