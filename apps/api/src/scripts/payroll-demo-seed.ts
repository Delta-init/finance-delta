/**
 * Loads a payroll month into a throwaway finance book and stops where the
 * screens are most worth looking at: imported, commission pulled, waiting for
 * accounts to approve and pay.
 *
 * Shares its shape with payroll-e2e.ts deliberately — this is the same journey,
 * left running rather than asserted and torn down.
 *
 * Run by scripts/payroll-demo.sh. Refuses anything but a scratch database.
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
import { hashPassword } from "../lib/password";

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
  if (!condition) failures++;
  console.log(`  ${condition ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${label}${detail ? ` — ${detail}` : ""}`);
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
    name: "Demo Accountant", email: "accounts@demo.local",
    // A real argon2 hash, because this one is meant to be logged into.
    passwordHash: await hashPassword(process.env.DEMO_PASSWORD ?? "Password123!"),
    memberships: [{ organizationId: org._id, roleId: role._id, status: "active" }],
  });
  const actor = { userId: String(admin._id) };

  // The salesperson gets a finance login, because commission hangs off one.
  const salesLogin = await User.create({
    name: "Aisha Rahman", email: "e2e001@e2e.local",
    passwordHash: await hashPassword(process.env.DEMO_PASSWORD ?? "Password123!"),
    memberships: [{ organizationId: org._id, roleId: role._id, status: "active" }],
  });

  const bank = await BankAccount.create({
    organizationId: org._id, accountName: "Main AED Current", accountType: "current",
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
  const withLogin = await Employee.countDocuments({ organizationId: org._id, userId: { $ne: null } });
  // Every mapped employee gets one — that is what makes them selectable as the
  // salesperson on an invoice.
  check("every mapped employee is a salesperson", withLogin === 3, `${withLogin} of 3 have a login`);

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


  console.log(`\n${"─".repeat(60)}`);
  console.log(
    failures === 0
      ? `\x1b[32mLoaded.\x1b[0m ${imported.runNumber} is waiting for accounts to approve and pay.`
      : `\x1b[31m${failures} of ${checks} steps failed.\x1b[0m`,
  );
  await mongoose.disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(`\n\x1b[31mFAILED: ${(err as Error).message}\x1b[0m`);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
