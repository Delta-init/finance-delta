/**
 * Drives the whole payroll handover against real databases and a real HRMS
 * server, over the signed HTTP the two systems actually use.
 *
 * Everything before this was typechecks and unit tests on pure functions. This
 * is the part that answers "does it work" — mapping, import, commission,
 * adjustments, approval, payment, reversal — and it exists because a payroll
 * whose round trip has never executed is a payroll nobody should run.
 *
 * Scope: the finance side runs in-process, calling its services directly. Its
 * HTTP layer is thin and typechecked; the untested weight is in the services
 * and in the HRMS round trip, and both are exercised here. HRMS runs as a real
 * server, so signing, the org scope and every integration route are real.
 *
 * Run through scripts/payroll-e2e.sh, which sets up the throwaway databases and
 * tears them down again. It refuses to run against anything that does not look
 * like a scratch database.
 */
import mongoose, { Types } from "mongoose";
import { Organization } from "../modules/organization/organization.model";
import { Department } from "../modules/department/department.model";
import { Role } from "../modules/role/role.model";
import { User } from "../modules/user/user.model";
import { BankAccount } from "../modules/banking/bank-account.model";
import { BankTransaction } from "../modules/banking/bank-transaction.model";
import { CommissionStructure } from "../modules/commission/commission-structure.model";
import { CommissionRecord } from "../modules/commission/commission-record.model";
import { Employee } from "../modules/employee/employee.model";
import { Expense } from "../modules/expense/expense.model";
import { PayrollRun } from "../modules/payroll/payroll-run.model";
import * as mapping from "../modules/payroll-mapping/mapping.service";
import * as payroll from "../modules/payroll/payroll.service";
import * as adjustments from "../modules/payroll/adjustments.service";
import * as payments from "../modules/payroll/payment.service";
import { hrmsClient } from "../lib/hrms-client";
import { formatMinor } from "../modules/payroll/money";

const uri = process.env.MONGODB_URI ?? "";
if (!/127\.0\.0\.1|localhost/.test(uri) || !/e2e|test/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch database, got "${uri}"`);
  process.exit(1);
}

const seed = JSON.parse(process.env.E2E_HRMS_SEED ?? "{}") as {
  orgId: string; month: string; netTotal: number; employeeCount: number;
  employees: Array<{ id: string; code: string; name: string; email: string }>;
};

let failures = 0;
let checks = 0;

function check(label: string, condition: boolean, detail = "") {
  checks++;
  if (condition) {
    console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures++;
    console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`);
  }
}

function step(name: string) {
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}

async function main() {
  await mongoose.connect(uri);
  await mongoose.connection.dropDatabase();

  // ── Finance-side fixtures ──────────────────────────────────────────────
  step("Setting up the finance book");
  const org = await Organization.create({ name: "Delta HQ", baseCurrency: "AED" });
  const orgId = String(org._id);
  const role = await Role.create({
    organizationId: org._id, key: "e2e-admin", name: "E2E Admin", permissions: ["*"],
  });
  const admin = await User.create({
    name: "E2E Accountant", email: `acct.${Date.now()}@e2e.local`, passwordHash: "x",
    memberships: [{ organizationId: org._id, roleId: role._id, status: "active" }],
  });
  const actor = { userId: String(admin._id) };

  // The salesperson gets a finance login, because commission hangs off one.
  const salesLogin = await User.create({
    name: "Aisha Rahman", email: "e2e001@e2e.local", passwordHash: "x",
    memberships: [{ organizationId: org._id, roleId: role._id, status: "active" }],
  });

  const bank = await BankAccount.create({
    organizationId: org._id, accountName: "Main AED Current", accountType: "checking",
    currency: "AED", currentBalanceMinor: 500_000_00, openingBalanceMinor: 500_000_00,
    openingDate: new Date("2024-01-01"),
  });
  check("bank account opened", bank.currentBalanceMinor === 500_000_00, formatMinor(bank.currentBalanceMinor, "AED"));

  // ── Reachability ───────────────────────────────────────────────────────
  step("1. Signed connection to HRMS");
  const pong = await hrmsClient.ping();
  check("HRMS answered a signed request", Boolean(pong.time), `service=${pong.service}`);

  const orgs = await hrmsClient.organizations();
  check("directory lists the HRMS organization", orgs.some((o) => o.id === seed.orgId));

  // ── Mapping ────────────────────────────────────────────────────────────
  step("2. Mapping (phase 0)");
  const link = await mapping.createOrgLink(orgId, { hrmsOrgId: seed.orgId }, actor);
  check("organization linked", Boolean(link.id), link.hrmsOrgName);
  check("no currency mismatch flagged", link.currencyMismatch === null);

  const preview = await mapping.previewSync(orgId, seed.orgId);
  check("preview found every employee", preview.employees.length === seed.employeeCount,
    `${preview.employees.length} of ${seed.employeeCount}`);
  check("departments proposed for creation", preview.departments.length === 2,
    preview.departments.map((d) => `${d.hrmsDepartmentName}:${d.state}`).join(", "));
  check("salesperson matched to a finance login by email",
    preview.employees.some((e) => e.employeeCode === "E2E001" && e.state === "proposed"));
  check("unbanked employee flagged before payroll",
    preview.employees.some((e) => e.employeeCode === "E2E003" && !e.hasBankDetails));

  const decisions = [
    ...preview.departments.map((d) => ({ kind: "department" as const, hrmsId: d.hrmsDepartmentId, action: "create" as const })),
    ...preview.employees.map((e) => ({
      kind: "employee" as const, hrmsId: e.hrmsEmployeeId,
      action: (e.state === "proposed" ? "link" : "create") as "link" | "create",
      targetUserId: e.state === "proposed" ? (e.userId ?? undefined) : undefined,
    })),
  ];
  const applied = await mapping.applySync(orgId, seed.orgId, decisions, actor);
  check("sync applied with no errors", applied.errors.length === 0, JSON.stringify(applied.errors));
  check("three employees imported", applied.employeesCreated + applied.employeesLinked === 3,
    `${applied.employeesCreated} created, ${applied.employeesLinked} linked`);

  const mapped = await Employee.countDocuments({ organizationId: org._id });
  check("employees persisted in finance", mapped === 3, `${mapped} rows`);
  // Every mapped employee gets one, because an invoice's salesperson and a
  // commission structure both reference a User — without a login they could not
  // be picked on either.
  const withLogin = await Employee.countDocuments({ organizationId: org._id, userId: { $ne: null } });
  check("every mapped employee is a salesperson", withLogin === 3, `${withLogin} of 3 have a login`);

  const provisioned = await User.findOne({ email: "e2e002@e2e.local" }).lean();
  check("a provisioned login exists for somebody who had none", Boolean(provisioned), provisioned?.email);
  check(
    "provisioned logins carry no permissions",
    Boolean(provisioned) &&
      (await Role.findById(provisioned!.memberships[0]!.roleId).lean())?.permissions.length === 0,
  );

  // ── Commission owed ────────────────────────────────────────────────────
  step("3. Commission the salesperson has earned");
  const structure = await CommissionStructure.create({
    organizationId: org._id, salespersonId: salesLogin._id, salespersonName: "Aisha Rahman",
    type: "percentage", percentage: 5, basis: "invoice_raised", effectiveFrom: new Date("2024-01-01"),
    createdById: admin._id,
  });
  for (const [i, amount] of [40_000_00, 60_000_00].entries()) {
    await CommissionRecord.create({
      organizationId: org._id, structureId: structure._id, salespersonId: salesLogin._id,
      salespersonName: "Aisha Rahman", invoiceId: new Types.ObjectId(), invoiceNumber: `INV-E2E-${i + 1}`,
      invoiceTotalMinor: amount, commissionMinor: Math.round(amount * 0.05),
      basis: "invoice_raised", status: "earned",
    });
  }
  check("two commissions earned and unpaid", (await CommissionRecord.countDocuments({ status: "earned" })) === 2,
    formatMinor(5_000_00, "AED"));

  // ── Import ─────────────────────────────────────────────────────────────
  step("4. Import the submitted month (phase 2)");
  const available = await payroll.listAvailable(orgId);
  check("HRMS is offering the month", available.some((b) => b.period === seed.month && !b.imported));

  const importPreview = await payroll.previewImport(orgId, seed.orgId, seed.month);
  check("import preflight passes", importPreview.canImport, importPreview.blockers.join(" "));
  check("net matches what HR submitted", importPreview.totals.netMinor === Math.round(seed.netTotal * 100),
    `${formatMinor(importPreview.totals.netMinor, "AED")} vs HR ${seed.netTotal}`);
  check("unbanked person warned about", importPreview.unpayable.length === 1,
    importPreview.unpayable.map((u) => u.name).join(", "));

  const imported = await payroll.importRun(orgId, seed.orgId, seed.month, actor);
  check("run created", Boolean(imported.runNumber), imported.runNumber);
  check("import raised no sync warning", imported.warnings.filter((w) => w.includes("could not be told")).length === 0);

  const claimed = await hrmsClient.payrollBatch(seed.orgId, seed.month);
  check("HRMS now shows the month as in_finance", claimed.status === "in_finance", claimed.status);

  const runId = imported.id;
  let run = await payroll.getRun(orgId, runId);
  check("unbanked person imported on hold", run.totals.heldCount === 1);
  check("held person is the one with no bank details",
    run.lines.find((l) => l.status === "on_hold")?.employeeCode === "E2E003");

  // ── Adjustments ────────────────────────────────────────────────────────
  step("5. Commission and adjustments (phase 3)");
  const pulled = await adjustments.pullCommissions(orgId, runId, actor);
  check("commission pulled onto the run", pulled.pulled === 1, pulled.message);

  run = await payroll.getRun(orgId, runId);
  const aisha = run.lines.find((l) => l.employeeCode === "E2E001")!;
  check("commission raised her payable by exactly the commission",
    aisha.adjustmentsMinor === 5_000_00, formatMinor(aisha.adjustmentsMinor, "AED"));
  check("commission written back to the payslip in HRMS",
    run.adjustments.every((a) => a.syncedAt !== null));

  const hrmsAfterCommission = await hrmsClient.payrollBatch(seed.orgId, seed.month);
  const aishaSlip = hrmsAfterCommission.lines.find((l) => l.employeeCode === "E2E001")!;
  check("HRMS payslip shows the commission as an earning",
    aishaSlip.earnings.some((e) => e.label.startsWith("Sales commission")),
    aishaSlip.earnings.map((e) => e.label).join(", "));
  check("HRMS net rose to match", Math.round(aishaSlip.netPay * 100) === aisha.payableMinor,
    `HRMS ${aishaSlip.netPay} vs finance ${aisha.payableMinor / 100}`);

  // A deduction larger than the month can absorb, on top of one already
  // carrying forward. This is the case the whole allocator exists for.
  const marcus = run.lines.find((l) => l.employeeCode === "E2E002")!;
  const deducted = await adjustments.addAdjustments(orgId, runId, [{
    lineId: marcus.id, kind: "deduction", label: "Equipment damage", amountMinor: 3_000_00,
  }], actor);
  check("oversized deduction accepted", deducted.outcomes.length === 1);
  check("system reported what it actually recovered", deducted.notes.length > 0,
    deducted.notes[0] ?? "(no note)");

  run = await payroll.getRun(orgId, runId);
  const marcusAfter = run.lines.find((l) => l.employeeCode === "E2E002")!;
  check("payable never went negative", marcusAfter.payableMinor >= 0,
    formatMinor(marcusAfter.payableMinor, "AED"));

  // ── Approve and pay ────────────────────────────────────────────────────
  step("6. Approve and pay (phase 4)");
  const approved = await payments.approveRun(orgId, runId, actor);
  check("run approved", approved.status === "approved");
  const hrmsApproved = await hrmsClient.payrollBatch(seed.orgId, seed.month);
  check("HRMS agrees the month is approved", hrmsApproved.status === "approved", hrmsApproved.status);

  const paid = await payments.payRun(orgId, runId, {
    bankAccountId: String(bank._id), method: "bank_transfer",
    paidOn: new Date().toISOString().slice(0, 10), reference: "WPS-E2E-001",
  }, actor);
  check("payment recorded", Boolean(paid.paymentId), `${paid.paymentId} ${paid.amountFormatted}`);
  check("HRMS acknowledged the payment", paid.synced, paid.warning ?? "");
  // One of the three has nothing to transfer: his whole salary went to the
  // advance recovery. Held plus zero-payable leaves exactly one real transfer.
  check("only people actually owed money were paid", paid.paidCount === 1, `${paid.paidCount} paid`);
  check("held person never entered the transfer", paid.heldCount === 1);
  check("commission settled by the payment", paid.commissionsSettled === 2, `${paid.commissionsSettled} records`);

  const bankAfter = await BankAccount.findById(bank._id).lean();
  check("bank balance fell by the payment",
    bankAfter!.currentBalanceMinor === 500_000_00 - paid.amountMinor,
    formatMinor(bankAfter!.currentBalanceMinor, "AED"));

  const tx = await BankTransaction.findById(paid.bankTransactionId).lean();
  check("bank transaction is matchable against the run",
    tx?.matches?.[0]?.type === "payroll" && tx.matches[0].referenceNumber === imported.runNumber);

  const expense = await Expense.findOne({ organizationId: org._id }).lean();
  check("payroll posted to the P&L", Boolean(expense) && expense!.status === "approved",
    expense ? `${expense.expenseNumber} ${formatMinor(expense.totalMinor ?? 0, "AED")}` : "no expense");

  const hrmsPaid = await hrmsClient.payrollBatch(seed.orgId, seed.month);
  check("HRMS shows the month partly paid", hrmsPaid.status === "partially_paid", hrmsPaid.status);
  const paidSlips = hrmsPaid.lines.filter((l) => l.status === "paid").length;
  check("the paid payslip says paid in HRMS", paidSlips === 1, `${paidSlips} paid`);
  check("held person's payslip still says issued",
    hrmsPaid.lines.find((l) => l.employeeCode === "E2E003")?.status === "issued");

  // Idempotency: the caller cannot tell a timeout from a failure, so the same
  // payment arriving twice must be recognised rather than applied again.
  const replay = await hrmsClient.recordPayment(seed.orgId, seed.month, {
    paymentId: paid.paymentId, paidOn: new Date().toISOString(),
    lines: [{ payslipId: hrmsPaid.lines[0]!.payslipId, amount: 1 }],
  });
  check("a replayed payment is recognised, not re-applied", replay.duplicate === true, replay.message);

  // ── Reversal ───────────────────────────────────────────────────────────
  step("7. Reverse a bounced payment (phase 5)");
  const reversed = await payments.reversePayment(orgId, runId, paid.paymentId, "Bank returned the transfer");
  check("payment reversed", !reversed.alreadyReversed, reversed.message);
  check("commission returned to unpaid", reversed.commissionsReopened === 2);

  const bankReversed = await BankAccount.findById(bank._id).lean();
  check("bank balance restored", bankReversed!.currentBalanceMinor === 500_000_00,
    formatMinor(bankReversed!.currentBalanceMinor, "AED"));

  const expenseVoided = await Expense.findOne({ organizationId: org._id }).lean();
  check("expense voided rather than deleted", expenseVoided?.status === "voided");

  const hrmsReversed = await hrmsClient.payrollBatch(seed.orgId, seed.month);
  const stillPaid = hrmsReversed.lines.filter((l) => l.status === "paid").length;
  check("no payslip still claims to be paid", stillPaid === 0, `${stillPaid} paid`);
  check("payslips returned to issued, not draft",
    hrmsReversed.lines.every((l) => l.status === "issued"));

  const earnedAgain = await CommissionRecord.countDocuments({ status: "earned" });
  check("commission is owed again", earnedAgain === 2, `${earnedAgain} earned`);

  const runFinal = await PayrollRun.findById(runId).lean();
  check("run no longer counts the money as paid", runFinal!.amountPaidMinor === 0,
    formatMinor(runFinal!.amountPaidMinor, "AED"));

  // ── Result ─────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(60)}`);
  if (failures === 0) {
    console.log(`\x1b[32m${checks} checks passed.\x1b[0m The handover works end to end.`);
  } else {
    console.log(`\x1b[31m${failures} of ${checks} checks FAILED.\x1b[0m`);
  }
  await mongoose.disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(`\n\x1b[31mFAILED: ${(err as Error).message}\x1b[0m`);
  console.error((err as Error).stack?.split("\n").slice(1, 5).join("\n"));
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
