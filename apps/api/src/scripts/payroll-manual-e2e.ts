/**
 * Manual payroll (the user, 2026-11-11: "In Payroll section there is no option to create or import data, still blank
 * page shows") — finance's services in this process, on a scratch database, HRMS stood in for in-process.
 *
 *   A. An organization on HRMS (HQ): can't make a manual month; a month from HR imports, approves and pays exactly as
 *      before, telling HRMS each step; manual line routes refuse its run.
 *   B. An organization switched to manual (Bangalore, INR): no HRMS waiting list and no HRMS import; a month made
 *      (its currency the organization's), a second for the same month and currency refused, another currency allowed
 *      and deleted; people typed, changed and removed; a sheet read by the shared reader and imported — bad rows
 *      reported, good rows added; totals and nets worked out; a new month straight from an import; HRMS-only actions
 *      refused; approve, undo, approve; paid from an INR account in two payments — bank lines and expenses as for a
 *      month from HR; reversed; nothing in "HRMS was not told".
 *   C. Not one call to HRMS during B.
 *
 * Run through scripts/payroll-manual-e2e.sh. Scratch databases only; HRMS_API_URL must be empty.
 */
import mongoose from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}
if (process.env.HRMS_API_URL) {
  console.error("Refusing to run: HRMS_API_URL must be empty — HRMS is stood in for here, never called.");
  process.exit(1);
}

const { Organization } = await import("../modules/organization/organization.model");
const { Role } = await import("../modules/role/role.model");
const { User } = await import("../modules/user/user.model");
const { BankAccount } = await import("../modules/banking/bank-account.model");
const { BankTransaction } = await import("../modules/banking/bank-transaction.model");
const { Employee } = await import("../modules/employee/employee.model");
const { Department } = await import("../modules/department/department.model");
const { Expense } = await import("../modules/expense/expense.model");
const { PayrollOrgLink } = await import("../modules/payroll-mapping/org-link.model");
const { PayrollRun } = await import("../modules/payroll/payroll-run.model");
const { updateOrganization, getOrganization } = await import("../modules/organization/organization.service");
const payroll = await import("../modules/payroll/payroll.service");
const payments = await import("../modules/payroll/payment.service");
const adjustments = await import("../modules/payroll/adjustments.service");
const manual = await import("../modules/payroll/manual.service");
const people = await import("../modules/payroll/people-report.service");
const schemas = await import("../modules/payroll/payroll.schemas");
const { hrmsClient } = await import("../lib/hrms-client");
const { findManualPayrollHeaderRow, matchManualPayrollColumns, readManualPayrollRows, MANUAL_PAYROLL_FIELDS } = await import("@delta/shared");
type HrmsBatch = Awaited<ReturnType<typeof hrmsClient.payrollBatch>>;

let checks = 0, failures = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const j = (v: unknown) => JSON.stringify(v).slice(0, 400);
const refusal = async (p: Promise<unknown>) => p.then(() => "", (e: Error) => e.message);

// ── HRMS, stood in for ───────────────────────────────────────────────────────
// Every method of the client is replaced. While `allowHrms` is on (part A) the few a month from HR needs answer as HRMS
// would; at any other time — all of part B — any call is recorded and refused.
const HRMS_ORG = "64b7f1c2a1b2c3d4e5f60718";
const MONTH = "2026-11";
let allowHrms = true;
const hrmsCalls: string[] = [];
const hqBatch: HrmsBatch = {
  month: MONTH, organizationId: HRMS_ORG, status: "submitted", currency: "AED", submittedAt: new Date().toISOString(), financeRunId: "",
  lines: [1, 2].map((n) => ({
    payslipId: `slip-${n}`, employeeId: `emp-${n}`, employeeCode: `HQ-00${n}`, name: `HQ Person ${n}`, departmentId: null,
    departmentName: "Operations", designation: "Executive", currency: "AED", grossPay: 10_000, totalDeductions: 0, netPay: 10_000,
    earnings: [{ label: "Basic", amount: 10_000 }], deductions: [], status: "issued", paidAt: null,
    bank: { iban: "AE070331234567890123456", accountNumber: "", bankName: "E2E Bank", nameInBank: "" }, payable: true,
  })),
  totals: { employeeCount: 2, grossTotal: 20_000, deductionTotal: 0, netTotal: 20_000, unpayable: 0 },
  snapshot: { employeeCount: 2, grossTotal: 20_000, deductionTotal: 0, netTotal: 20_000 },
} as unknown as HrmsBatch;
const answers: Record<string, (...args: any[]) => unknown> = {
  payrollBatches: () => [{ month: MONTH, status: "submitted", currency: "AED", employeeCount: 2, grossTotal: 20_000, deductionTotal: 0, netTotal: 20_000, submittedAt: hqBatch.submittedAt, financeRunId: "" }],
  payrollBatch: () => hqBatch,
  claimPayrollBatch: () => ({ month: MONTH, status: "in_finance" }),
  approveBatch: () => ({ month: MONTH, status: "approved" }),
  recordPayment: (_o: string, _m: string, body: { lines: unknown[] }) => ({ duplicate: false, message: "ok", month: MONTH, status: "paid", paidCount: body.lines.length }),
};
const client = hrmsClient as unknown as Record<string, unknown>;
for (const name of Object.keys(client)) {
  if (typeof client[name] !== "function" || name === "isConfigured") continue;
  client[name] = async (...args: unknown[]) => {
    hrmsCalls.push(name);
    if (allowHrms && answers[name]) return answers[name]!(...args);
    throw new Error(`HRMS must not be called here (e2e): ${name}`);
  };
}

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();

try {
  const hq = await Organization.create({ name: "Delta HQ E2E", baseCurrency: "AED", lateEntryDays: 0 });
  const blr = await Organization.create({ name: "Delta Bangalore E2E", baseCurrency: "INR", lateEntryDays: 0 });
  const HQ = String(hq._id), BLR = String(blr._id);
  const role = await Role.create({ organizationId: hq._id, key: "e2e-admin", name: "E2E Admin", permissions: ["*"] });
  const admin = await User.create({
    name: "E2E Accountant", email: `acct.${Date.now()}@e2e-manual.test`, passwordHash: "x",
    memberships: [{ organizationId: hq._id, roleId: role._id, status: "active" }, { organizationId: blr._id, roleId: role._id, status: "active" }],
  });
  const actor = { userId: String(admin._id) };
  const account = (orgId: unknown, name: string, currency: string) => BankAccount.create({
    organizationId: orgId, accountName: name, accountType: "current", currency,
    currentBalanceMinor: 1_000_000_00, openingBalanceMinor: 1_000_000_00, openingDate: new Date("2026-01-01"),
  });
  const hqAed = await account(hq._id, "HQ AED Current", "AED");
  const blrInr = await account(blr._id, "Bangalore INR Current", "INR");
  const blrAed = await account(blr._id, "Bangalore AED Current", "AED");

  /* ── A ── */
  step("A. An organization on HRMS (HQ) — as before");
  check("every organization starts on HRMS", (await getOrganization(HQ)).payrollMode === "hrms" && (await getOrganization(BLR)).payrollMode === "hrms");
  check("…and the payroll pages are told so", (await manual.payrollSetup(HQ)).mode === "hrms");
  const hqRefused = await refusal(manual.createManualRun(HQ, { period: MONTH }, actor));
  check("an HRMS organization can't make a manual month", hqRefused.includes("comes from HRMS") && hqRefused.includes("Settings → Payroll"), hqRefused);
  check("…and nothing was made", (await PayrollRun.countDocuments({ organizationId: hq._id })) === 0);

  await PayrollOrgLink.create({ organizationId: hq._id, hrmsOrgId: HRMS_ORG, hrmsOrgName: "HQ in HRMS", hrmsCurrency: "AED", isActive: true });
  await Employee.insertMany(hqBatch.lines.map((l) => ({ organizationId: hq._id, hrmsOrgId: HRMS_ORG, hrmsEmployeeId: l.employeeId, employeeCode: l.employeeCode, name: l.name })));
  const waiting = await payroll.listAvailable(HQ);
  check("the month waiting from HR is listed, read from HRMS", waiting.length === 1 && !waiting[0]!.imported && hrmsCalls.includes("payrollBatches"), j(waiting));
  const hqImported = await payroll.importRun(HQ, HRMS_ORG, MONTH, actor);
  check("imported from HR, and HRMS told it is claimed", hqImported.employeeCount === 2 && hrmsCalls.includes("claimPayrollBatch"), j(hqImported));
  const hqRun = await payroll.getRun(HQ, hqImported.id);
  check("a month from HR says so", hqRun.source === "hrms" && hqRun.hrmsOrgId === HRMS_ORG && hqRun.hrmsOrgName === "HQ in HRMS");
  const hqLineRefused = await refusal(manual.addManualLines(HQ, hqImported.id, { lines: [{ name: "Someone", grossMinor: 1_00 }] }));
  check("people can't be typed onto a month from HR", hqLineRefused.includes("came from HRMS"), hqLineRefused);
  const hqEditRefused = await refusal(manual.updateManualLine(HQ, hqImported.id, hqRun.lines[0]!.id, { name: "Renamed", grossMinor: 1_00 }));
  const hqDeleteRefused = await refusal(manual.deleteManualRun(HQ, hqImported.id));
  check("…nor changed, nor the month deleted", hqEditRefused.includes("came from HRMS") && hqDeleteRefused.includes("came from HRMS"));
  await payments.approveRun(HQ, hqImported.id, actor);
  check("approving tells HRMS", hrmsCalls.includes("approveBatch"));
  const hqPaid = await payments.payRun(HQ, hqImported.id, { bankAccountId: String(hqAed._id), method: "bank_transfer", paidOn: "2026-11-28" }, actor);
  check("paying tells HRMS, and it confirms", hqPaid.synced === true && hrmsCalls.includes("recordPayment") && hqPaid.amountMinor === 20_000_00, j(hqPaid));
  const hqAfter = await PayrollRun.findById(hqImported.id).lean();
  check("the HRMS month is paid, its payment confirmed by HRMS", hqAfter!.status === "paid" && hqAfter!.payments[0]!.syncedToHrms === true);
  const hqExpense = await Expense.findById(hqPaid.expenseId).lean();
  check("…and posted as an expense, as always", hqExpense?.totalMinor === 20_000_00 && hqExpense?.currency === "AED" && (hqExpense?.source as { kind?: string })?.kind === "payroll");

  /* ── B ── */
  allowHrms = false;
  const callsBeforeB = hrmsCalls.length;

  step("B1. Bangalore switched to manual");
  const switched = await updateOrganization(BLR, { payrollMode: "manual" });
  check("Settings → Payroll: manual", switched.payrollMode === "manual" && (await getOrganization(BLR)).payrollMode === "manual");
  check("HQ is still on HRMS", (await getOrganization(HQ)).payrollMode === "hrms");
  const setup = await manual.payrollSetup(BLR);
  check("the payroll pages are told: manual, months in INR", setup.mode === "manual" && setup.baseCurrency === "INR", j(setup));
  check("nothing waits from HR — and HRMS isn't asked", (await payroll.listAvailable(BLR)).length === 0);
  await PayrollOrgLink.create({ organizationId: blr._id, hrmsOrgId: "64b7f1c2a1b2c3d4e5f60799", hrmsOrgName: "Stray link", hrmsCurrency: "INR", isActive: true });
  const importRefused = await refusal(payroll.previewImport(BLR, "64b7f1c2a1b2c3d4e5f60799", MONTH));
  const importRefused2 = await refusal(payroll.importRun(BLR, "64b7f1c2a1b2c3d4e5f60799", MONTH, actor));
  check("an HRMS import is refused, even with a link left over", importRefused.includes("enters its payroll in finance") && importRefused2.includes("enters its payroll in finance"), importRefused);
  check("…still nothing waits from HR", (await payroll.listAvailable(BLR)).length === 0);

  step("B2. A month, once per month and currency");
  const nov = await manual.createManualRun(BLR, { period: MONTH }, actor);
  check("made, in the organization's currency", nov.currency === "INR" && /^PAY-202611-\d{3}$/.test(nov.runNumber) && nov.created === 0, j(nov));
  const novDoc = await PayrollRun.findById(nov.id).lean();
  check("a manual run: no HRMS organization behind it", novDoc!.source === "manual" && novDoc!.hrmsOrgId === "manual:INR" && novDoc!.status === "imported" && novDoc!.lines.length === 0, j({ source: novDoc!.source, hrmsOrgId: novDoc!.hrmsOrgId }));
  const dup = await refusal(manual.createManualRun(BLR, { period: MONTH, currency: "inr" }, actor));
  check("the same month and currency again is refused, naming the run", dup.includes("already") && dup.includes(nov.runNumber), dup);
  const novAed = await manual.createManualRun(BLR, { period: MONTH, currency: "AED" }, actor);
  check("the same month in another currency is its own month", novAed.currency === "AED" && novAed.id !== nov.id);
  const deleted = await manual.deleteManualRun(BLR, novAed.id);
  check("a month made by mistake can be deleted before approval", deleted.runNumber === novAed.runNumber && !(await PayrollRun.exists({ _id: novAed.id })));
  check("the route's schema wants YYYY-MM and a 3-letter currency", !schemas.createManualRunSchema.safeParse({ period: "2026-1" }).success && !schemas.createManualRunSchema.safeParse({ period: MONTH, currency: "RUPEES" }).success && schemas.createManualRunSchema.safeParse({ period: MONTH }).success);
  const runs = await payroll.listRuns(BLR, {});
  check("listed, marked as entered in finance", runs.data.length === 1 && runs.data[0]!.source === "manual" && runs.data[0]!.hrmsOrgName === "Entered in finance", j(runs.data));

  step("B3. People typed, changed and removed");
  await Department.create({ organizationId: blr._id, name: "Operations" });
  await Employee.create({ organizationId: blr._id, hrmsOrgId: "none", hrmsEmployeeId: "none-1", employeeCode: "E-001", name: "Employee One" });
  const one = await manual.addManualLines(BLR, nov.id, {
    lines: [{
      employeeCode: "E-001", name: "Employee One", departmentName: "operations", designation: "Executive", bankName: "Example Bank",
      accountNumber: "000123456789", ifsc: "EXMP0000001", grossMinor: 45_000_00, deductions: { pf: 1_800_00, professionalTax: 200_00, tds: 1_500_00 },
    }],
  });
  check("one person added", one.created === 1 && one.employeeCount === 1, j(one));
  let run = await payroll.getRun(BLR, nov.id);
  let l1 = run.lines[0]!;
  check("net is gross less PF, professional tax and TDS", l1.grossMinor === 45_000_00 && l1.deductionsMinor === 3_500_00 && l1.netFromHrmsMinor === 41_500_00 && l1.payableMinor === 41_500_00, j(l1));
  check("deductions stored by name; gross as the earning", JSON.stringify(l1.deductions.map((d) => d.label)) === JSON.stringify(["PF", "Professional tax", "TDS (income tax)"]) && l1.earnings[0]?.label === "Gross pay");
  check("bank and IFSC kept; INR; to pay", l1.bank?.accountNumber === "000123456789" && l1.bank?.ifsc === "EXMP0000001" && l1.currency === "INR" && l1.status === "pending");
  check("linked to the employee with that code, and the department with that name", Boolean(l1.employeeId) && Boolean((await PayrollRun.findById(nov.id).lean())!.lines[0]!.departmentId));
  check("HRMS ids say manual — never an HRMS id", l1.hrmsEmployeeId === `manual:${l1.id}`);
  check("the run's totals follow", run.totals.hrmsGrossMinor === 45_000_00 && run.totals.payableMinor === 41_500_00 && run.totals.balanceMinor === 41_500_00 && run.source === "manual");

  const noName = await refusal(manual.addManualLines(BLR, nov.id, { lines: [{ name: "", grossMinor: 10_000_00 }] }));
  check("a typed person without a name is refused, saying so", noName.includes("Name is missing"), noName);
  const negative = await refusal(manual.addManualLines(BLR, nov.id, { lines: [{ name: "Employee Neg", grossMinor: 1_000_00, deductions: { other: 2_000_00 } }] }));
  check("…and one whose deductions are more than their gross", negative.includes("negative"), negative);
  const dupCode = await refusal(manual.addManualLines(BLR, nov.id, { lines: [{ employeeCode: "e-001", name: "Somebody Else", grossMinor: 1_000_00 }] }));
  check("…and an employee code already on the month", dupCode.includes("already on this month"), dupCode);

  const edited = await manual.updateManualLine(BLR, nov.id, l1.id, {
    employeeCode: "E-001", name: "Employee One", departmentName: "Operations", grossMinor: 50_000_00, deductions: { pf: 1_800_00, professionalTax: 200_00, tds: 1_500_00, esi: 0 },
    accountNumber: "000123456789", ifsc: "EXMP0000001", bankName: "Example Bank",
  });
  run = await payroll.getRun(BLR, nov.id);
  l1 = run.lines[0]!;
  check("changed: gross 50,000 — net 46,500, the run's payable with it", l1.payableMinor === 46_500_00 && run.totals.payableMinor === 46_500_00 && edited.message.includes("updated"), j(l1));
  const badEdit = await refusal(manual.updateManualLine(BLR, nov.id, l1.id, { name: "Employee One", grossMinor: 50_000_00, netMinor: 49_000_00 }));
  check("a change whose stated net disagrees is refused", badEdit.includes("Net in the file"), badEdit);
  const noCode = await manual.addManualLines(BLR, nov.id, { lines: [{ name: "Employee Without Code", grossMinor: 10_000_00 }] });
  const noCodeLine = (await payroll.getRun(BLR, nov.id)).lines.find((l) => l.name === "Employee Without Code");
  check("an employee code is optional on a manual month", noCode.created === 1 && noCodeLine?.employeeCode === "" && noCodeLine?.payableMinor === 10_000_00, j(noCodeLine));
  await manual.removeManualLine(BLR, nov.id, noCodeLine!.id);
  const hrmsNoCode = await refusal(PayrollRun.create({
    organizationId: hq._id, hrmsOrgId: HRMS_ORG, runNumber: "PAY-E2E-X", period: "2026-01", currency: "AED",
    lines: [{ hrmsPayslipId: "s", hrmsEmployeeId: "e", employeeCode: "", name: "No Code", grossMinor: 1, deductionsMinor: 0, netFromHrmsMinor: 1, payableMinor: 1 }],
  }));
  check("…but still required on a month from HRMS, as before", hrmsNoCode.includes("employeeCode"), hrmsNoCode);

  step("B4. A sheet imported — read as the browser reads it");
  const heads = MANUAL_PAYROLL_FIELDS.map((f) => f.label);
  const sheet: unknown[][] = [
    ["Bangalore payroll — November 2026"],
    heads,
    ["E-002", "Employee Two", "Sales", "Advisor", "INR", "Example Bank", "000222", "EXMP0000002", "₹21,000.00", "1,800", "157.50", "200", "", "500", "18,342.50"],
    ["E-003", "Employee Three", "Sales", "Advisor", "", "", "", "", "Rs. 30,000/-", "1800", "", "200", "1,000", "", "27,000"],
    ["E-004", "", "Sales", "", "", "", "", "", "25,000", "", "", "", "", "", ""],
    ["E-005", "Employee Five", "", "", "", "", "", "", "20,000", "1,800", "", "200", "", "", "19,000"],
    ["E-006", "Employee Six", "", "", "", "", "", "", "5,000", "", "", "", "", "6,000", ""],
    ["E-001", "Employee One Again", "", "", "", "", "", "", "10,000", "", "", "", "", "", ""],
    ["E-007", "Employee Seven", "", "", "AED", "", "", "", "10,000", "", "", "", "", "", ""],
    ["E-008", "Employee Eight", "", "", "", "", "", "", "abc", "", "", "", "", "", ""],
    ["E-009", "Employee Nine", "Operations", "", "", "", "", "", 40_000, 1_800, 0, 200, 2_000, 0, 36_000],
    [],
    ["Total", "", "", "", "", "", "", "", "1,61,000"],
  ];
  const hr = findManualPayrollHeaderRow(sheet);
  const read = readManualPayrollRows(sheet, hr, matchManualPayrollColumns(sheet[hr]!));
  check("the shared reader finds the headings and every column", hr === 1 && Object.keys(matchManualPayrollColumns(sheet[hr]!)).length === heads.length);
  check("a gross that isn't an amount is left out with why; blank and total rows passed over",
    read.unreadable.length === 1 && read.unreadable[0]!.rowNo === 10 && read.unreadable[0]!.problems[0]!.includes("abc") && read.skipped === 2, j(read.unreadable));
  const imported = await manual.addManualLines(BLR, nov.id, { lines: read.lines, partial: true });
  check("the good rows added (3), the bad ones reported (5)", imported.created === 3 && imported.problems.length === 5, j(imported));
  const why = (rowNo: number) => imported.problems.find((p) => p.rowNo === rowNo)?.problems.join("; ") ?? "";
  check("row 5: no name", why(5).includes("Name is missing"), why(5));
  check("row 6: its net disagrees with gross less deductions", why(6).includes("Net in the file is 19,000.00"), why(6));
  check("row 7: its net would be negative", why(7).includes("negative"), why(7));
  check("row 8: an employee code already on the month", why(8).includes("already on this month"), why(8));
  check("row 9: paid in another currency", why(9).includes("this month is in INR"), why(9));
  run = await payroll.getRun(BLR, nov.id);
  const byName = (n: string) => run.lines.find((l) => l.name === n)!;
  check("₹21,000 less PF, ESI, PT and other: 18,342.50", byName("Employee Two").payableMinor === 18_342_50, j(byName("Employee Two")));
  check("Rs. 30,000/- less PF, PT and TDS: 27,000", byName("Employee Three").payableMinor === 27_000_00);
  check("an Excel number read as it is: 40,000 less 4,000", byName("Employee Nine").payableMinor === 36_000_00);
  const sum = (f: (l: (typeof run.lines)[number]) => number) => run.lines.reduce((a, l) => a + f(l), 0);
  check("4 people; the run's gross, deductions and payable are its lines'",
    run.totals.employeeCount === 4 && run.totals.hrmsGrossMinor === sum((l) => l.grossMinor) && run.totals.hrmsDeductionsMinor === sum((l) => l.deductionsMinor) &&
      run.totals.payableMinor === 46_500_00 + 18_342_50 + 27_000_00 + 36_000_00 && run.totals.payableMinor === sum((l) => l.payableMinor), j(run.totals));
  check("totals per currency: one, INR", run.byCurrency.length === 1 && run.byCurrency[0]!.currency === "INR" && run.byCurrency[0]!.payableMinor === run.totals.payableMinor);

  const removed = await manual.removeManualLine(BLR, nov.id, byName("Employee Nine").id);
  run = await payroll.getRun(BLR, nov.id);
  check("a person removed; totals follow", removed.employeeCount === 3 && run.totals.payableMinor === 46_500_00 + 18_342_50 + 27_000_00, j(run.totals));

  step("B5. A new month straight from an import");
  const oct = await manual.createManualRun(BLR, {
    period: "2026-10",
    lines: [
      { rowNo: 2, employeeCode: "E-001", name: "Employee One", grossMinor: 45_000_00, deductions: { pf: 1_800_00 }, netMinor: 43_200_00 },
      { rowNo: 3, employeeCode: "E-002", name: "Employee Two", grossMinor: 21_000_00 },
      { rowNo: 4, employeeCode: "E-003", name: "", grossMinor: 30_000_00 },
    ],
  }, actor);
  check("made with the good rows, the bad one reported", oct.created === 2 && oct.problems.length === 1 && oct.problems[0]!.rowNo === 4 && oct.byCurrency[0]!.payableMinor === 64_200_00, j(oct));
  const allBad = await refusal(manual.createManualRun(BLR, { period: "2026-09", lines: [{ name: "", grossMinor: 0 }] }, actor));
  check("an import with nothing good makes no month", allBad.includes("None of the 1") && !(await PayrollRun.exists({ organizationId: blr._id, period: "2026-09" })), allBad);
  const empty = await manual.createManualRun(BLR, { period: "2026-08" }, actor);
  const emptyApprove = await refusal(payments.approveRun(BLR, empty.id, actor));
  check("an empty month can't be approved", emptyApprove.includes("nobody on it"), emptyApprove);
  await manual.deleteManualRun(BLR, empty.id);

  step("B6. HRMS-only actions refused on a manual month");
  const line = run.lines[0]!;
  const hrmsOnly: Array<[string, () => Promise<unknown>]> = [
    ["add or deduct", () => adjustments.addAdjustments(BLR, nov.id, [{ lineId: line.id, kind: "addition", label: "Bonus", amountMinor: 1_000_00 }], actor)],
    ["remove an addition", () => adjustments.removeAdjustment(BLR, nov.id, "x:y:1")],
    ["Pull earned commission", () => adjustments.pullCommissions(BLR, nov.id, actor)],
    ["Pull CS commission", () => adjustments.pullCsCommission(BLR, nov.id, actor)],
    ["Pull salary slabs", () => adjustments.pullSlabSalaries(BLR, nov.id, actor)],
    ["Send back to HR", () => payments.returnRun(BLR, nov.id, "Wrong figures")],
  ];
  for (const [what, act] of hrmsOnly) {
    const said = await refusal(act());
    check(`${what}: refused`, said.includes("entered in finance"), said);
  }

  step("B7. Approve, undo, approve — and the people locked");
  const approved = await payments.approveRun(BLR, nov.id, actor);
  check("approved", approved.status === "approved");
  const lockedAdd = await refusal(manual.addManualLines(BLR, nov.id, { lines: [{ name: "Late Joiner", grossMinor: 1_000_00 }] }));
  const lockedEdit = await refusal(manual.updateManualLine(BLR, nov.id, line.id, { name: "X", grossMinor: 1_00 }));
  const lockedRemove = await refusal(manual.removeManualLine(BLR, nov.id, line.id));
  const lockedDelete = await refusal(manual.deleteManualRun(BLR, nov.id));
  check("once approved, nobody can be added, changed or removed, nor the month deleted",
    [lockedAdd, lockedEdit, lockedRemove, lockedDelete].every((m) => m.includes("undo the approval")), j([lockedAdd, lockedEdit]));
  const undone = await payments.unapproveRun(BLR, nov.id, "Approved by mistake");
  check("the approval undone — back to open", undone.status === "imported");
  await payments.approveRun(BLR, nov.id, actor);

  step("B8. Paid from the INR account, in two payments");
  const before = (await BankAccount.findById(blrInr._id).lean())!.currentBalanceMinor;
  const aedRefused = await refusal(payments.payRun(BLR, nov.id, { bankAccountId: String(blrAed._id), method: "bank_transfer", paidOn: "2026-11-28" }, actor));
  check("an AED account can't pay INR salaries", aedRefused.includes("paid in INR") || aedRefused.includes("another currency"), aedRefused);
  run = await payroll.getRun(BLR, nov.id);
  const first = await payments.payRun(BLR, nov.id, { bankAccountId: String(blrInr._id), method: "bank_transfer", paidOn: "2026-11-28", lineIds: [byName("Employee One").id] }, actor);
  check("the first payment: one person, INR 46,500, no HRMS warning", first.paidCount === 1 && first.amountMinor === 46_500_00 && first.currency === "INR" && first.warning === null, j(first));
  const tx1 = await BankTransaction.findById(first.bankTransactionId).lean();
  check("its bank line: a matched payroll debit in INR", tx1?.amountMinor === -46_500_00 && tx1?.type === "debit" && tx1?.currency === "INR" && tx1?.matches?.[0]?.type === "payroll" && tx1?.matches?.[0]?.referenceNumber === nov.runNumber, j(tx1));
  const exp1 = await Expense.findById(first.expenseId).lean();
  check("its expense: approved, INR, paid from the account through that line",
    exp1?.status === "approved" && exp1?.currency === "INR" && exp1?.totalMinor === 46_500_00 && String(exp1?.bankTransactionId) === first.bankTransactionId &&
      (exp1?.source as { kind?: string })?.kind === "payroll", j(exp1));
  check("part paid", (await payroll.getRun(BLR, nov.id)).status === "partially_paid");
  const second = await payments.payRun(BLR, nov.id, { bankAccountId: String(blrInr._id), method: "bank_transfer", paidOn: "2026-11-29" }, actor);
  check("the second pays everybody left", second.paidCount === 2 && second.amountMinor === 18_342_50 + 27_000_00 && second.status === "paid", j(second));
  const after = (await BankAccount.findById(blrInr._id).lean())!.currentBalanceMinor;
  check("the INR account is down by the month's payable", before - after === 46_500_00 + 18_342_50 + 27_000_00, `${before} → ${after}`);
  check("two bank lines and two expenses for the month",
    (await BankTransaction.countDocuments({ organizationId: blr._id, "matches.referenceId": nov.id })) === 2 &&
      (await Expense.countDocuments({ organizationId: blr._id, "source.kind": "payroll", status: "approved" })) === 2);
  run = await payroll.getRun(BLR, nov.id);
  check("paid; its payments never went to HRMS", run.status === "paid" && run.payments.every((p) => p.syncedToHrms === false));
  const attention = await payroll.reconciliation(BLR);
  check("nothing in \"HRMS was not told\"", attention.unsyncedPayments.length === 0, j(attention.unsyncedPayments));
  const breakdown = await payments.payrollBreakdownOfExpense(BLR, String(first.expenseId));
  check("the expense's payment record has no HRMS badge to show", breakdown !== null && breakdown.syncedToHrms === undefined && breakdown.rows[0]?.name === "Employee One", j(breakdown));
  const retry = await refusal(payments.retrySync(BLR, nov.id, first.paymentId));
  check("there is nothing to retry with HRMS", retry.includes("entered in finance"), retry);
  const person = await Employee.findOne({ organizationId: blr._id, employeeCode: "E-001" }).lean();
  const detail = await people.personDetail(BLR, String(person!._id), { from: "2026-11-01", to: "2026-11-30" });
  check("the linked person's page shows the month", detail.payslips.some((p) => p.runNumber === nov.runNumber && p.amountPaidMinor === 46_500_00), j(detail.payslips));

  step("B9. A payment reversed");
  const reversed = await payments.reversePayment(BLR, nov.id, second.paymentId, "Bounced (e2e)");
  check("reversed, money back, expense voided", reversed.status === "partially_paid" && (await Expense.findById(second.expenseId).lean())?.status === "voided" &&
    (await BankAccount.findById(blrInr._id).lean())!.currentBalanceMinor === after + second.amountMinor, j(reversed));
  check("its two people owed again", (await payroll.getRun(BLR, nov.id)).lines.filter((l) => l.status === "pending").length === 2);

  /* ── C ── */
  step("C. HRMS");
  check("not one call to HRMS for the manual organization", hrmsCalls.length === callsBeforeB, j(hrmsCalls.slice(callsBeforeB)));
  check("HQ's month from HR untouched by it all", (await PayrollRun.findById(hqImported.id).lean())!.status === "paid");
} finally {
  await mongoose.connection.db!.dropDatabase();
  await mongoose.disconnect();
}

console.log(`\n${checks - failures}/${checks} checks passed${failures ? ` — ${failures} failed` : ""}`);
process.exit(failures ? 1 : 0);
