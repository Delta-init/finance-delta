import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { env } from "./config/env";
import { connectDb } from "./config/db";
import { logger } from "./lib/logger";
import { ok } from "./lib/http";
import { errorHandler, notFound } from "./middleware/errorHandler";
import authRoutes from "./modules/auth/auth.routes";
import userRoutes from "./modules/user/user.routes";
import roleRoutes from "./modules/role/role.routes";
import customerRoutes from "./modules/customer/customer.routes";
import quotationRoutes from "./modules/quotation/quotation.routes";
import salesOrderRoutes from "./modules/salesorder/salesorder.routes";
import tagRoutes from "./modules/tag/tag.routes";
import departmentRoutes from "./modules/department/department.routes";
import invoiceRoutes from "./modules/invoice/invoice.routes";
import integrationRoutes from "./modules/integrations/integrations.routes";
import organizationRoutes from "./modules/organization/organization.routes";
import searchRoutes from "./modules/search/search.routes";
import suggestionsRoutes from "./modules/suggestions/suggestions.routes";
import creditNoteRoutes from "./modules/credit-note/credit-note.routes";
import paymentRoutes from "./modules/invoice/payment.routes";
import vendorRoutes from "./modules/vendor/vendor.routes";
import purchaseOrderRoutes from "./modules/purchase-order/purchase-order.routes";
import billRoutes from "./modules/bill/bill.routes";
import vendorCreditRoutes from "./modules/vendor-credit/vendor-credit.routes";
import expenseRoutes from "./modules/expense/expense.routes";
import expenseCategoryRoutes from "./modules/expense-category/expense-category.routes";
import bankingRoutes from "./modules/banking/banking.routes";
import inventoryRoutes from "./modules/inventory/inventory.routes";
import reportRoutes from "./modules/reports/reports.routes";
import commissionRoutes from "./modules/commission/commission.routes";
import loanRoutes from "./modules/loan/loan.routes";
import platformRoutes from "./modules/platform/platform.routes";
import dashboardRoutes from "./modules/dashboard/dashboard.routes";
import payrollMappingRoutes from "./modules/payroll-mapping/mapping.routes";
import payrollRoutes from "./modules/payroll/payroll.routes";
import { startRecurringWorker } from "./jobs/recurring-invoice.worker";
import { startReminderWorker } from "./jobs/reminder.worker";
import { startRecurringExpenseWorker } from "./jobs/recurring-expense.worker";
import { startPayrollWaitingWorker } from "./jobs/payroll-waiting.worker";

async function bootstrap() {
  await connectDb();

  const app = express();

  app.use(helmet());
  app.use(
    cors({
      origin: env.WEB_ORIGIN.split(",").map((o) => o.trim()),
      credentials: true,
    }),
  );
  app.use(
    express.json({
      limit: "1mb",
      // Kept so a signed request can be verified against the bytes that
      // actually arrived. Re-serialising the parsed body would change key
      // order or number formatting and break honest signatures.
      verify: (req, _res, buf) => {
        (req as typeof req & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use(cookieParser());

  app.get("/health", (_req, res) => ok(res, { status: "ok" }));

  const api = express.Router();
  api.use("/auth", authRoutes);
  api.use("/users", userRoutes);
  api.use("/roles", roleRoutes);
  api.use("/customers", customerRoutes);
  api.use("/quotations", quotationRoutes);
  api.use("/sales-orders", salesOrderRoutes);
  api.use("/tags", tagRoutes);
  api.use("/departments", departmentRoutes);
  api.use("/invoices", invoiceRoutes);
  // Signed server-to-server calls. Guarded by its own middleware, not the
  // session cookie every other route uses.
  api.use("/integrations", integrationRoutes);
  api.use("/organizations", organizationRoutes);
  api.use("/search", searchRoutes);
  api.use("/suggestions", suggestionsRoutes);
  api.use("/credit-notes", creditNoteRoutes);
  api.use("/payments", paymentRoutes);
  api.use("/vendors", vendorRoutes);
  api.use("/purchase-orders", purchaseOrderRoutes);
  api.use("/bills", billRoutes);
  api.use("/vendor-credits", vendorCreditRoutes);
  api.use("/expenses", expenseRoutes);
  api.use("/expense-categories", expenseCategoryRoutes);
  api.use("/bank-accounts", bankingRoutes);
  api.use("/inventory", inventoryRoutes);
  api.use("/reports", reportRoutes);
  api.use("/commissions", commissionRoutes);
  api.use("/loans", loanRoutes);
  api.use("/platform", platformRoutes);
  api.use("/dashboard", dashboardRoutes);
  api.use("/payroll-mapping", payrollMappingRoutes);
  api.use("/payroll", payrollRoutes);
  app.use("/api/v1", api);

  app.use(notFound);
  app.use(errorHandler);

  app.listen(env.API_PORT, () => {
    logger.info(`API listening on http://localhost:${env.API_PORT}`);
  });

  // Off in a second process against the same database: these issue invoices
  // and send mail on a timer, and two of them do it twice.
  if (env.RUN_SCHEDULERS) {
    void startRecurringWorker();
    void startReminderWorker();
    void startRecurringExpenseWorker();
    void startPayrollWaitingWorker();
  } else {
    logger.warn("RUN_SCHEDULERS=false — the timed jobs are not running in this process");
  }
}

bootstrap().catch((err) => {
  logger.error({ err }, "Failed to start API");
  process.exit(1);
});
