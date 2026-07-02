import { Router } from "express";
import { authenticate } from "../../middleware/auth";
import { requirePermission } from "../../middleware/rbac";
import * as c from "./loan.controller";

const router = Router();
router.use(authenticate);

// Loans
router.get("/", requirePermission("loan:read"), c.listLoans);
router.get("/report", requirePermission("loan:read"), c.loanReport);
router.get("/:id", requirePermission("loan:read"), c.getLoan);
router.post("/", requirePermission("loan:write"), c.createLoan);
router.patch("/:id", requirePermission("loan:write"), c.updateLoan);

// Repayments (nested under loan)
router.get("/:id/repayments", requirePermission("loan:read"), c.listRepayments);
router.post("/:id/repayments", requirePermission("loan:write"), c.recordRepayment);
router.delete("/:id/repayments/:repaymentId", requirePermission("loan:write"), c.deleteRepayment);

export default router;
