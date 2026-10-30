/**
 * Payroll in two currencies, end to end against a throwaway database.
 *
 * October 2026 handed finance 81 dirham payslips and 22 rupee ones, and every
 * figure added them together: the import screen read AED 972,458.21 for
 * AED 344,824.88 and INR 627,633.33, and paying "everybody" from the dirham
 * account would have taken the rupee salaries out of it as dirhams. This drives
 * the real services (the waiting list, the preview, the import, the run list,
 * approval, payment, reversal, what needs attention, a person's payslips) with
 * HRMS stood in for in-process, so nothing outside this machine is touched.
 *
 * Run from apps/api, against a scratch database only:
 *   MONGODB_URI=mongodb://127.0.0.1:27017/finance-payroll-currency-e2e \
 *   JWT_ACCESS_SECRET=e2e-access-secret-0123456789 JWT_REFRESH_SECRET=e2e-refresh-secret-0123456789 \
 *   bun --no-env-file src/scripts/payroll-currency-e2e.ts
 */
import mongoose from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)[:/]/.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a local scratch database, got "${uri}"`);
  process.exit(1);
}

const { Organization } = await import("../modules/organization/organization.model");
const { Role } = await import("../modules/role/role.model");
const { User } = await import("../modules/user/user.model");
const { BankAccount } = await import("../modules/banking/bank-account.model");
const { Employee } = await import("../modules/employee/employee.model");
const { Expense } = await import("../modules/expense/expense.model");
const { PayrollOrgLink } = await import("../modules/payroll-mapping/org-link.model");
const { PayrollRun } = await import("../modules/payroll/payroll-run.model");
const payroll = await import("../modules/payroll/payroll.service");
const payments = await import("../modules/payroll/payment.service");
const people = await import("../modules/payroll/people-report.service");
const { hrmsClient } = await import("../lib/hrms-client");
type HrmsBatch = Awaited<ReturnType<typeof hrmsClient.payrollBatch>>;
type HrmsBatchSummary = Awaited<ReturnType<typeof hrmsClient.payrollBatches>>[number];

let checks = 0;
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗"} ${label}${detail ? ` — ${detail}` : ""}${ok ? "" : "\x1b[0m"}`);
}
const step = (name: string) => console.log(`\n\x1b[1m${name}\x1b[0m`);
async function refusal(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return ""; } catch (e) { return (e as Error).message; }
}

// ── HRMS, stood in for ───────────────────────────────────────────────────────
const HRMS_ORG = "hrms-org-e2e";
const bank = (on: boolean) => ({ iban: on ? "AE070331234567890123456" : "", accountNumber: "", bankName: on ? "E2E Bank" : "", nameInBank: "" });
const slip = (n: number, code: string, name: string, currency: string, gross: number, deductions: number, payable = true) => ({
  payslipId: `slip-${n}`, employeeId: `emp-${n}`, employeeCode: code, name,
  departmentId: null, departmentName: "Sales", designation: "Advisor", currency,
  grossPay: gross, totalDeductions: deductions, netPay: Math.round((gross - deductions) * 100) / 100,
  earnings: [{ label: "Basic", amount: gross }], deductions: deductions ? [{ label: "Loan", amount: deductions }] : [],
  status: "issued", paidAt: null, bank: bank(payable), payable,
});
const lines = [
  slip(1, "E001", "Aisha Rahman", "AED", 12_000, 500),
  slip(2, "E002", "Omar Said", "AED", 8_250.5, 0),
  slip(3, "E003", "Held Person", "AED", 5_000, 0, false),
  slip(4, "B001", "Rahul Sharma", "INR", 85_000, 5_000),
  slip(5, "B002", "Vandana K", "INR", 60_000.75, 0),
];
const r2 = (n: number) => Math.round(n * 100) / 100;
// Added across currencies, exactly as HRMS adds them to check its lines.
const mixed = {
  grossTotal: r2(lines.reduce((a, l) => a + l.grossPay, 0)),
  deductionTotal: r2(lines.reduce((a, l) => a + l.totalDeductions, 0)),
  netTotal: r2(lines.reduce((a, l) => a + l.netPay, 0)),
};
const october: HrmsBatch = {
  month: "2026-10", organizationId: HRMS_ORG, status: "submitted", currency: "AED", submittedAt: new Date().toISOString(),
  financeRunId: "", lines,
  totals: { employeeCount: 5, ...mixed, unpayable: 1 },
  snapshot: { employeeCount: 5, ...mixed },
};
const summaries: HrmsBatchSummary[] = [
  // Submitted before HRMS split its totals: one mixed figure, no breakdown.
  { month: "2026-10", status: "submitted", currency: "AED", employeeCount: 5, ...mixed, submittedAt: october.submittedAt, financeRunId: "" },
  // From an HRMS that splits them: its own count is the dirham people alone.
  {
    month: "2026-11", status: "submitted", currency: "AED", employeeCount: 3, grossTotal: 25_250.5, deductionTotal: 500, netTotal: 24_750.5,
    byCurrency: [
      { currency: "AED", employeeCount: 3, grossTotal: 25_250.5, deductionTotal: 500, netTotal: 24_750.5 },
      { currency: "INR", employeeCount: 2, grossTotal: 145_000.75, deductionTotal: 5_000, netTotal: 140_000.75 },
    ],
    submittedAt: october.submittedAt, financeRunId: "",
  },
];
let batchFetches = 0;
let recordFails = false;
const recorded: Array<{ paymentId: string; lines: number }> = [];
const fake = hrmsClient as unknown as Record<string, unknown>;
fake.payrollBatches = async () => summaries;
fake.payrollBatch = async (_org: string, month: string) => {
  batchFetches++;
  if (month !== "2026-10") throw new Error(`no batch for ${month}`);
  return october;
};
fake.claimPayrollBatch = async () => ({ month: "2026-10", status: "in_finance" });
fake.approveBatch = async () => ({ month: "2026-10", status: "approved" });
fake.recordPayment = async (_org: string, _month: string, body: { paymentId: string; lines: unknown[] }) => {
  if (recordFails) throw new Error("HRMS is down (e2e)");
  recorded.push({ paymentId: body.paymentId, lines: body.lines.length });
  return { duplicate: false, message: "ok", month: "2026-10", status: "partially_paid", paidCount: body.lines.length };
};
fake.reversePayment = async () => ({ month: "2026-10", status: "approved", reversed: 1 });

// ── The book ─────────────────────────────────────────────────────────────────
await mongoose.connect(uri);
await mongoose.connection.dropDatabase();
try {
  step("Setting up a dirham book with a dirham and a rupee account");
  const org = await Organization.create({ name: "Delta HQ E2E", baseCurrency: "AED", lateEntryDays: 0 });
  const orgId = String(org._id);
  const role = await Role.create({ organizationId: org._id, key: "e2e-admin", name: "E2E Admin", permissions: ["*"] });
  const admin = await User.create({
    name: "E2E Accountant", email: `acct.${Date.now()}@e2e.local`, passwordHash: "x",
    memberships: [{ organizationId: org._id, roleId: role._id, status: "active" }],
  });
  const actor = { userId: String(admin._id) };
  const aed = await BankAccount.create({
    organizationId: org._id, accountName: "Main AED Current", accountType: "current", currency: "AED",
    currentBalanceMinor: 500_000_00, openingBalanceMinor: 500_000_00, openingDate: new Date("2026-01-01"),
  });
  const inr = await BankAccount.create({
    organizationId: org._id, accountName: "Bangalore INR Current", accountType: "current", currency: "INR",
    currentBalanceMinor: 2_000_000_00, openingBalanceMinor: 2_000_000_00, openingDate: new Date("2026-01-01"),
  });
  await PayrollOrgLink.create({
    organizationId: org._id, hrmsOrgId: HRMS_ORG, hrmsOrgName: "Delta International Management Development Training",
    hrmsCurrency: "AED", isActive: true,
  });
  const employees = await Employee.insertMany(
    lines.map((l) => ({ organizationId: org._id, hrmsOrgId: HRMS_ORG, hrmsEmployeeId: l.employeeId, employeeCode: l.employeeCode, name: l.name })),
  );
  check("book ready", employees.length === 5);

  step("1. Waiting from HR");
  const available = await payroll.listAvailable(orgId);
  const oct = available.find((b) => b.period === "2026-10")!;
  const nov = available.find((b) => b.period === "2026-11")!;
  check(
    "a month submitted before HRMS split its totals is worked out from its payslips",
    JSON.stringify(oct.byCurrency) === JSON.stringify([
      { currency: "AED", employeeCount: 3, netMinor: 24_750_50 },
      { currency: "INR", employeeCount: 2, netMinor: 140_000_75 },
    ]) && oct.employeeCount === 5,
    JSON.stringify(oct.byCurrency),
  );
  check(
    "a month from an HRMS that splits them uses its split, and counts everybody",
    nov.byCurrency.length === 2 && nov.byCurrency[1]!.netMinor === 140_000_75 && nov.employeeCount === 5,
    `${nov.employeeCount} people, ${JSON.stringify(nov.byCurrency)}`,
  );
  check("only the month without a split was asked for its payslips", batchFetches === 1, `${batchFetches} fetch(es)`);

  step("2. The import dialog's figures");
  const preview = await payroll.previewImport(orgId, HRMS_ORG, "2026-10");
  check("can import", preview.canImport, preview.blockers.join(" "));
  check(
    "net per currency, dirhams first",
    JSON.stringify(preview.byCurrency.map((c) => [c.currency, c.employeeCount, c.netMinor])) ===
      JSON.stringify([["AED", 3, 24_750_50], ["INR", 2, 140_000_75]]),
    JSON.stringify(preview.byCurrency),
  );
  check("gross and deductions per currency too", preview.byCurrency[1]!.grossMinor === 145_000_75 && preview.byCurrency[1]!.deductionsMinor === 5_000_00);
  check("the mixed check total is still there for HRMS's reconciliation", preview.totals.netMinor === 164_751_25);
  check("the held person is still warned about", preview.warnings.some((w) => w.includes("no bank details")));

  step("3. Import");
  const imported = await payroll.importRun(orgId, HRMS_ORG, "2026-10", actor);
  check("the confirmation names each currency's amount", imported.netFormatted === "AED 24,750.50 + INR 140,000.75", imported.netFormatted);
  const runId = imported.id;
  const listed = (await payroll.listRuns(orgId, {})).data[0]!;
  check(
    "the run list carries payable per currency",
    listed.byCurrency.map((c) => `${c.currency}:${c.payableMinor}:${c.balanceMinor}`).join(",") === "AED:2475050:2475050,INR:14000075:14000075",
    JSON.stringify(listed.byCurrency),
  );
  await payments.approveRun(orgId, runId, actor);

  step("4. Paying from the dirham account");
  const aedPay = await payments.payRun(orgId, runId, { bankAccountId: String(aed._id), method: "bank_transfer", paidOn: "2026-10-30" }, actor);
  check("pays only the dirham people who can be paid", aedPay.paidCount === 2 && aedPay.amountMinor === 19_750_50, `${aedPay.paidCount} people, ${aedPay.amountFormatted}`);
  check("in dirhams", aedPay.currency === "AED" && aedPay.amountFormatted === "AED 19,750.50");
  const aedAfter = await BankAccount.findById(aed._id).lean();
  check("the dirham account drops by the dirham salaries alone", aedAfter!.currentBalanceMinor === 500_000_00 - 19_750_50, String(aedAfter!.currentBalanceMinor));
  const aedExpense = await Expense.findById(aedPay.expenseId).lean();
  check("its expense is in dirhams for the dirham amount", aedExpense?.currency === "AED" && aedExpense?.totalMinor === 19_750_50, `${aedExpense?.currency} ${aedExpense?.totalMinor}`);
  check("HRMS was told about the two it paid", recorded.at(-1)?.lines === 2);

  const attention = await payroll.reconciliation(orgId);
  const unfinished = attention.unfinished.find((u) => u.runId === runId);
  check(
    "needs attention says what is still owed per currency",
    JSON.stringify(unfinished?.outstandingByCurrency) === JSON.stringify([
      { currency: "AED", outstandingMinor: 5_000_00 },
      { currency: "INR", outstandingMinor: 140_000_75 },
    ]),
    JSON.stringify(unfinished?.outstandingByCurrency),
  );
  check("the held person is listed in their own currency", attention.heldPeople[0]?.currency === "AED");

  const again = await refusal(() =>
    payments.payRun(orgId, runId, { bankAccountId: String(aed._id), method: "bank_transfer", paidOn: "2026-10-30" }, actor));
  check(
    "the dirham account refuses to pay anybody else, and says why",
    again.includes("held") && again.includes("another currency"),
    again,
  );

  step("5. Paying from the rupee account");
  const heldLine = (await PayrollRun.findById(runId).lean())!.lines.find((l) => l.employeeCode === "E003")!;
  const inrLines = (await PayrollRun.findById(runId).lean())!.lines.filter((l) => l.currency === "INR");
  const inrPay = await payments.payRun(orgId, runId, {
    bankAccountId: String(inr._id), method: "bank_transfer", paidOn: "2026-10-30",
    // A dirham person named alongside: left out, never paid in rupees.
    lineIds: [String(heldLine._id), ...inrLines.map((l) => String(l._id))],
  }, actor);
  check("pays the two rupee people, in rupees", inrPay.paidCount === 2 && inrPay.amountFormatted === "INR 140,000.75", inrPay.amountFormatted);
  const inrAfter = await BankAccount.findById(inr._id).lean();
  check("the rupee account drops by the rupee salaries", inrAfter!.currentBalanceMinor === 2_000_000_00 - 140_000_75);
  const inrExpense = await Expense.findById(inrPay.expenseId).lean();
  check("its expense is in rupees", inrExpense?.currency === "INR" && inrExpense?.totalMinor === 140_000_75);

  const run = await payroll.getRun(orgId, runId);
  check("each payment carries its currency", run.payments.map((p) => p.currency).join(",") === "AED,INR");
  check(
    "the run's totals per currency: dirhams owed only the held person, rupees settled",
    run.byCurrency.map((c) => `${c.currency}:${c.amountPaidMinor}:${c.balanceMinor}`).join(",") === "AED:1975050:500000,INR:14000075:0",
    JSON.stringify(run.byCurrency),
  );
  check("still partly paid while somebody is held", run.status === "partially_paid", run.status);

  step("6. Reversing the rupee payment");
  const reversed = await payments.reversePayment(orgId, runId, inrPay.paymentId, "Bounced (e2e)");
  check("the message is in rupees", reversed.message.startsWith("INR 140,000.75 reversed"), reversed.message);
  const inrBack = await BankAccount.findById(inr._id).lean();
  check("the rupee account gets it back", inrBack!.currentBalanceMinor === 2_000_000_00);
  const voided = await Expense.findById(inrPay.expenseId).lean();
  check("its rupee expense is voided", voided?.status === "voided");

  step("7. A payment HRMS never heard about");
  recordFails = true;
  const unheard = await payments.payRun(orgId, runId, { bankAccountId: String(inr._id), method: "bank_transfer", paidOn: "2026-10-30" }, actor);
  recordFails = false;
  check("recorded, flagged unsynced", unheard.synced === false && unheard.paidCount === 2);
  const attention2 = await payroll.reconciliation(orgId);
  check("needs attention shows it in rupees", attention2.unsyncedPayments.find((p) => p.paymentId === unheard.paymentId)?.currency === "INR");

  step("8. A person's payslips");
  const rahul = employees.find((e) => e.employeeCode === "B001")!;
  const detail = await people.personDetail(orgId, String(rahul._id), { from: "2026-10-01", to: "2026-10-31" });
  check("a rupee salary reads as rupees on the person's page", detail.payslips[0]?.currency === "INR", detail.payslips[0]?.currency);
} finally {
  // The unsynced payment's notice is sent in the background; let it finish
  // writing its email log, or it re-creates the database after the drop.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
