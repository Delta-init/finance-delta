import { Router } from "express";
import {
  createBankAccountSchema,
  updateBankAccountSchema,
  createBankTransactionSchema,
  updateBankTransactionSchema,
  bulkImportTransactionsSchema,
  previewImportSchema,
  matchTransactionSchema,
  cashCountSchema,
  updateCashCountSchema,
  startReconciliationSchema,
  updateReconciliationSchema,
} from "@delta/shared";
import { authenticate } from "../../middleware/auth";
import { requirePermission } from "../../middleware/rbac";
import { validateBody } from "../../middleware/validate";
import * as c from "./banking.controller";

const router = Router();
router.use(authenticate);

// Bank accounts
router.get("/", requirePermission("banking:read"), c.listAccounts);
router.get("/:id", requirePermission("banking:read"), c.getAccount);
router.post("/", requirePermission("banking:write"), validateBody(createBankAccountSchema), c.createAccount);
router.patch("/:id", requirePermission("banking:write"), validateBody(updateBankAccountSchema), c.updateAccount);
router.post("/:id/deactivate", requirePermission("banking:write"), c.deactivateAccount);

// Transactions
router.get("/:id/transactions", requirePermission("banking:read"), c.listTransactions);
router.post("/:id/transactions", requirePermission("banking:write"), validateBody(createBankTransactionSchema), c.createTransaction);
router.post("/:id/transactions/bulk", requirePermission("banking:write"), validateBody(bulkImportTransactionsSchema), c.bulkImport);
// Reads only — it reports which lines are already on the account and writes
// nothing, so it needs no more than the write permission the import itself has.
router.post("/:id/transactions/import-preview", requirePermission("banking:write"), validateBody(previewImportSchema), c.previewImport);
router.get("/:id/transactions/:txId", requirePermission("banking:read"), c.getTransaction);
// Correcting or removing an entry. Refused once it has been reconciled or
// matched to a document — see assertEditable in the service.
router.patch("/:id/transactions/:txId", requirePermission("banking:write"), validateBody(updateBankTransactionSchema), c.updateTransaction);
router.delete("/:id/transactions/:txId", requirePermission("banking:write"), c.deleteTransaction);
router.post("/:id/transactions/:txId/match", requirePermission("banking:write"), validateBody(matchTransactionSchema), c.matchTransaction);
router.post("/:id/transactions/:txId/unmatch", requirePermission("banking:write"), c.unmatchTransaction);
router.post("/:id/transactions/:txId/exclude", requirePermission("banking:write"), c.excludeTransaction);
router.post("/:id/transactions/:txId/duplicate", requirePermission("banking:write"), c.markDuplicate);
// The way back from either. Excluding and flagging a duplicate were both
// one-way, so a row marked in error stayed marked.
router.post("/:id/transactions/:txId/restore", requirePermission("banking:write"), c.restoreTransaction);

// Reconciliation
router.get("/:id/reconciliations", requirePermission("banking:read"), c.listReconciliations);
router.post("/:id/reconciliations", requirePermission("banking:reconcile"), validateBody(startReconciliationSchema), c.startReconciliation);
router.get("/:id/reconciliations/:sessionId", requirePermission("banking:read"), c.getReconciliation);
router.patch("/:id/reconciliations/:sessionId", requirePermission("banking:reconcile"), validateBody(updateReconciliationSchema), c.updateReconciliation);
router.post("/:id/reconciliations/:sessionId/complete", requirePermission("banking:reconcile"), c.completeReconciliation);
// Counting a tin, which settles it in one go rather than line by line.
router.post("/:id/cash-count", requirePermission("banking:reconcile"), validateBody(cashCountSchema), c.recordCashCount);
// Correcting or withdrawing one. A count locks the entries it covered, so
// withdrawing it is the only way back to a row that needs fixing.
router.patch("/:id/cash-count/:sessionId", requirePermission("banking:reconcile"), validateBody(updateCashCountSchema), c.updateCashCount);
router.delete("/:id/cash-count/:sessionId", requirePermission("banking:reconcile"), c.deleteCashCount);

export default router;
