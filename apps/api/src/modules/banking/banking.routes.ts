import { Router } from "express";
import {
  createBankAccountSchema,
  updateBankAccountSchema,
  createBankTransactionSchema,
  bulkImportTransactionsSchema,
  matchTransactionSchema,
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
router.get("/:id/transactions/:txId", requirePermission("banking:read"), c.getTransaction);
router.post("/:id/transactions/:txId/match", requirePermission("banking:write"), validateBody(matchTransactionSchema), c.matchTransaction);
router.post("/:id/transactions/:txId/unmatch", requirePermission("banking:write"), c.unmatchTransaction);
router.post("/:id/transactions/:txId/exclude", requirePermission("banking:write"), c.excludeTransaction);
router.post("/:id/transactions/:txId/duplicate", requirePermission("banking:write"), c.markDuplicate);

// Reconciliation
router.get("/:id/reconciliations", requirePermission("banking:read"), c.listReconciliations);
router.post("/:id/reconciliations", requirePermission("banking:reconcile"), validateBody(startReconciliationSchema), c.startReconciliation);
router.get("/:id/reconciliations/:sessionId", requirePermission("banking:read"), c.getReconciliation);
router.patch("/:id/reconciliations/:sessionId", requirePermission("banking:reconcile"), validateBody(updateReconciliationSchema), c.updateReconciliation);
router.post("/:id/reconciliations/:sessionId/complete", requirePermission("banking:reconcile"), c.completeReconciliation);

export default router;
