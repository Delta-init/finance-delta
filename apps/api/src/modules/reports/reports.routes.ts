import { Router } from "express";
import { authenticate } from "../../middleware/auth";
import { requirePermission } from "../../middleware/rbac";
import * as c from "./reports.controller";

const router = Router();
router.use(authenticate);
router.use(requirePermission("report:read"));

// 8.1 Receivables
router.get("/receivables/payments", c.receivedPayments);
router.get("/receivables/aged", c.agedReceivables);
router.get("/receivables/summary", c.invoiceSummary);
router.get("/daily", c.dailyReport);
router.get("/daily/breakdown", c.dailyBreakdown);

// 8.2 Payables
router.get("/payables/payments", c.madePayments);
router.get("/payables/aged", c.agedPayables);

// 8.3 P&L
router.get("/profit-loss", c.profitLoss);

// 8.4 Balance Sheet
router.get("/balance-sheet", c.balanceSheet);

// 8.5 Cash Flow
router.get("/cash-flow", c.cashFlow);

// 8.6 Tax
router.get("/tax/vat", c.vatReport);

// 8.7 Other
router.get("/sales-by-item", c.salesByItem);
router.get("/expense-by-category", c.expenseByCategory);
router.get("/customer-statement/:customerId", c.customerStatement);

// Expense and Revenue reports: grouped by any dimension, filtered by any (2026-10-24)
router.get("/expense-analysis", c.expenseAnalysis);
router.get("/revenue-analysis", c.revenueAnalysis);

export default router;
