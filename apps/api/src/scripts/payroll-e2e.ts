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
import { CrmCommissionPayout } from "../modules/crm-commission/crm-commission-payout.model";
import { CsCommissionPayout } from "../modules/cs-commission/cs-commission-payout.model";
import * as crmCommission from "../modules/crm-commission/crm-commission.service";
import http from "node:http";

const uri = process.env.MONGODB_URI ?? "";
if (!/127\.0\.0\.1|localhost/.test(uri) || !/e2e|test/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch database, got "${uri}"`);
  process.exit(1);
}

const seed = JSON.parse(process.env.E2E_HRMS_SEED ?? "{}") as {
  orgId: string; month: string; netTotal: number; employeeCount: number; hrEmail: string;
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

  // Marcus has left (inactive here) by the time the month comes over: he must start held (2026-10-30).
  await Employee.updateOne({ organizationId: org._id, employeeCode: "E2E002" }, { $set: { status: "inactive" } });
  const imported = await payroll.importRun(orgId, seed.orgId, seed.month, actor);
  check("run created", Boolean(imported.runNumber), imported.runNumber);
  check("import raised no sync warning", imported.warnings.filter((w) => w.includes("could not be told")).length === 0);

  const claimed = await hrmsClient.payrollBatch(seed.orgId, seed.month);
  check("HRMS now shows the month as in_finance", claimed.status === "in_finance", claimed.status);

  const runId = imported.id;
  let run = await payroll.getRun(orgId, runId);
  const leaver = run.lines.find((l) => l.employeeCode === "E2E002")!;
  check("somebody who has left imported on hold, and why", leaver.status === "on_hold" && leaver.holdReason === payroll.LEFT_HOLD_REASON, leaver.holdReason);
  check("…and marked as left; nobody else is", leaver.left && run.lines.filter((l) => l.left).length === 1);
  const refused = async (p: Promise<unknown>, re: RegExp) => { try { await p; return false; } catch (e) { return re.test((e as Error).message); } };
  const e2e003 = run.lines.find((l) => l.employeeCode === "E2E003")!;
  // No bank details in HRMS is no longer a hold (2026-11-05: "if the person has no bank we can also send his money").
  check("somebody with no bank details: imported to be paid, not held — marked as having none",
    e2e003.status === "pending" && e2e003.payable === false && e2e003.holdReason === "", `${e2e003.status} ${e2e003.holdReason}`);
  const heldNadia = await payments.setLineHold(orgId, runId, e2e003.id, { hold: true, reason: "Waiting for her bank details" }, actor);
  check("…accounts can still hold her by hand", heldNadia.status === "on_hold" && /^Waiting for her bank details/.test(heldNadia.holdReason), heldNadia.holdReason);
  check("a held person cannot be held again", await refused(payments.setLineHold(orgId, runId, leaver.id, { hold: true }, actor), /only somebody not paid yet/));
  const released = await payments.setLineHold(orgId, runId, leaver.id, { hold: false }, actor);
  check("accounts release him: his final salary is owed", released.status === "pending" && released.holdReason === "");
  const aishaLine = run.lines.find((l) => l.employeeCode === "E2E001")!;
  const held = await payments.setLineHold(orgId, runId, aishaLine.id, { hold: true, reason: "Checking her bank" }, actor);
  check("anybody not paid yet can be held, with the reason and by whom", held.status === "on_hold" && /^Checking her bank \(held by /.test(held.holdReason), held.holdReason);
  check("…and released again", (await payments.setLineHold(orgId, runId, aishaLine.id, { hold: false }, actor)).status === "pending");
  await Employee.updateOne({ organizationId: org._id, employeeCode: "E2E002" }, { $set: { status: "active" } });
  run = await payroll.getRun(orgId, runId);
  check("the left mark follows finance now: back on, not left", !run.lines.some((l) => l.left));
  check("one person held", run.totals.heldCount === 1);
  check("held person is the one accounts held",
    run.lines.find((l) => l.status === "on_hold")?.employeeCode === "E2E003");

  // ── Adjustments ────────────────────────────────────────────────────────
  step("5. Commission and adjustments (phase 3)");
  // The sales CRMs' commission through payroll (2026-11-01): a stand-in Root names Aisha's CRM login by her email.
  // It also gives the CRM salary slabs (2026-11-01), as `slabs` says.
  const slabs: { people: unknown[]; failures: unknown[] } = { people: [], failures: [] };
  const rootApi = http.createServer((req, res) => {
    const send = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.headers["x-portal-secret"] !== "e2e-root-secret") return send(401, { success: false, message: "Invalid service credential" });
    if ((req.url ?? "").startsWith("/api/v1/service/finance/slab-pay")) return send(200, { success: true, data: { month: seed.month, ...slabs } });
    if (!(req.url ?? "").startsWith("/api/v1/service/crm-commission")) return send(404, { success: false, message: "Route not found" });
    send(200, { success: true, data: { crms: [{ code: "delta", name: "Sales CRM", currency: "AED", error: null, total: 0, pending: { progress: 0, waiting: 0 }, people: [
      { userId: "crm-aisha", name: "Aisha", email: "E2E001@e2e.local", roles: ["sales"], amount: 230, sales: 1, lines: [] },
      { userId: "crm-ghost", name: "Ghost", email: "ghost@e2e.local", roles: ["sales"], amount: 100, sales: 1, lines: [] },
    ] }] } });
  });
  await new Promise<void>((ok) => rootApi.listen(Number(process.env.E2E_ROOT_PORT), "127.0.0.1", ok));
  const payout = (userId: string, name: string, month: string, amountMinor: number, state: "approved" | "paid") => ({
    key: `delta:${month}:${userId}`, organizationId: org._id, crm: "delta", crmName: "Sales CRM", month, userId, personName: name, currency: "AED",
    amountMinor, state, approvedById: new Types.ObjectId(actor.userId), approvedByName: "Mona Manager", approvedAt: new Date(),
  });
  const prev = `${Number(seed.month.slice(0, 4)) - (seed.month.slice(5) === "01" ? 1 : 0)}-${seed.month.slice(5) === "01" ? "12" : String(Number(seed.month.slice(5)) - 1).padStart(2, "0")}`;
  await CrmCommissionPayout.insertMany([
    payout("crm-aisha", "Aisha", seed.month, 230_00, "approved"),
    payout("crm-ghost", "Ghost", seed.month, 100_00, "approved"),
    payout("crm-aisha", "Aisha", prev, 150_00, "paid"),
    payout("crm-aisha", "Aisha", "2099-01", 999_00, "approved"),
  ]);
  const pulled = await adjustments.pullCommissions(orgId, runId, actor);
  check("commission pulled onto the run: hers, and her approved CRM commission", pulled.pulled === 2, pulled.message);
  check("…the approved CRM commission of somebody not on this run said, not added", /Ghost \(Sales CRM/.test(pulled.message), pulled.message);

  run = await payroll.getRun(orgId, runId);
  const aisha = run.lines.find((l) => l.employeeCode === "E2E001")!;
  check("commission raised her payable by exactly the commission — 5,000 and the CRM's 230",
    aisha.adjustmentsMinor === 5_230_00, formatMinor(aisha.adjustmentsMinor, "AED"));
  const crmAdj = run.adjustments.find((a) => a.source === "crm_commission");
  check("…the CRM's as its own addition, named for the CRM and month", !!crmAdj && /^Sales commission \(CRM\) — Sales CRM, /.test(crmAdj.label) && crmAdj.amountMinor === 230_00, crmAdj?.label);
  let mine = await CrmCommissionPayout.findOne({ key: `delta:${seed.month}:crm-aisha` }).lean();
  check("…the CRM commission is now on this run, still approved", mine?.state === "approved" && mine.payrollRunNumber === run.runNumber);
  check("…the paid month, the month to come and Ghost's left as they were", (await CrmCommissionPayout.countDocuments({ payrollRunId: { $ne: null } })) === 1);
  const refusedHere = async (p: Promise<unknown>, re: RegExp) => { try { await p; return false; } catch (e) { return re.test((e as Error).message); } };
  check("on a run, the CRM commission page won't pay it, nor take the approval back",
    await refusedHere(crmCommission.payCrmCommission(orgId, actor.userId, { crm: "delta", month: seed.month, userId: "crm-aisha", paidOn: "2026-01-01", paymentMethod: "bank_transfer", receipt: { key: `expenses/${orgId}/uploads/x.pdf`, name: "x.pdf", url: "https://x/x.pdf", size: 1, mimeType: "application/pdf" } } as never), /payroll/)
    && await refusedHere(crmCommission.revokeCrmCommission(orgId, actor.userId, true, { crm: "delta", month: seed.month, userId: "crm-aisha" }), /payroll/));
  await adjustments.removeAdjustment(orgId, runId, crmAdj!.externalId);
  mine = await CrmCommissionPayout.findOne({ key: `delta:${seed.month}:crm-aisha` }).lean();
  check("taken off the run: the CRM commission is free again", mine?.state === "approved" && !mine.payrollRunId, String(mine?.payrollRunNumber));
  const again = await adjustments.pullCommissions(orgId, runId, actor);
  check("…and pulled again: only it", again.pulled === 1, again.message);
  // The CS Portal's commission through payroll (2026-11-03): a CS period approved on the CS commission page, found by
  // the CS's CS Portal email; one a later month ends isn't this run's.
  await CsCommissionPayout.insertMany([
    { key: `bonus:${seed.month}:cs-aisha`, organizationId: org._id, kind: "bonus", period: seed.month, lastMonth: seed.month, recipientId: "cs-aisha", personName: "Aisha",
      email: "e2e001@e2e.local", location: "dubai", currency: "AED", amountMinor: 367_00, amountUsd: 100, creditIds: ["c1"], state: "approved",
      approvedById: new Types.ObjectId(actor.userId), approvedByName: "Mona Manager", approvedAt: new Date() },
    { key: "deposit:2099-Q1:cs-aisha", organizationId: org._id, kind: "deposit", period: "2099-Q1", lastMonth: "2099-03", recipientId: "cs-aisha", personName: "Aisha",
      email: "e2e001@e2e.local", location: "dubai", currency: "AED", amountMinor: 999_00, amountUsd: 272.21, creditIds: ["c9"], state: "approved",
      approvedById: new Types.ObjectId(actor.userId), approvedByName: "Mona Manager", approvedAt: new Date() },
  ]);
  const csPulled = await adjustments.pullCommissions(orgId, runId, actor);
  const csAdj = (await payroll.getRun(orgId, runId)).adjustments.find((a) => a.source === "cs_commission");
  check("the CS commission pulled too: AED 367 for her bonus month, named for it; the quarter to come left", csPulled.pulled === 1
    && csAdj?.amountMinor === 367_00 && /^CS commission — Bonus, /.test(csAdj.label), `${csPulled.message} | ${csAdj?.label}`);
  const csMine = await CsCommissionPayout.findOne({ key: `bonus:${seed.month}:cs-aisha` }).lean();
  check("…on this run, still approved", csMine?.state === "approved" && csMine.payrollRunNumber === (await payroll.getRun(orgId, runId)).runNumber
    && !(await CsCommissionPayout.findOne({ key: "deposit:2099-Q1:cs-aisha" }).lean())?.payrollRunId);
  // The CRM salary slabs (2026-11-01): Aisha's contract is 12,000; HR sent a whole month, no days off.
  const onSlab = (salary: number, more: object[] = []) => [
    { crm: "delta", crmName: "Sales CRM", userId: "crm-aisha", name: "Aisha", email: "E2E001@e2e.local", role: "sales", level: "A", salary, currency: "AED", percent: 100, earned: 230, payable: 230 },
    ...more,
  ];
  const slabItems = async () => (await payroll.getRun(orgId, runId)).adjustments.filter((a) => a.source === "crm_slab");
  const aishaEarnings = async () => (await hrmsClient.payrollBatch(seed.orgId, seed.month)).lines.find((l) => l.employeeCode === "E2E001")!;
  slabs.people = onSlab(15_000, [
    { crm: "delta", crmName: "Sales CRM", userId: "crm-nadia", name: "Nadia", email: "e2e003@e2e.local", role: "sales", level: "Base", salary: 50_000, currency: "INR", percent: 0, earned: 0, payable: 0 },
    { crm: "draw", crmName: "Draw", userId: "crm-ghost", name: "Ghost", email: "ghost@e2e.local", role: "sales", level: "Base", salary: 2_000, currency: "AED", percent: 0, earned: 0, payable: 0 },
  ]);
  const hrSalary = (await aishaEarnings()).salary;
  check("HRMS sends Aisha's salary: 12,000 a month, 12,000 on this payslip", hrSalary?.monthly === 12_000 && hrSalary.paid === 12_000, JSON.stringify(hrSalary));
  let slabbed = await adjustments.pullSlabSalaries(orgId, runId, actor);
  let items = await slabItems();
  check("salary slabs pulled: Aisha on A, 15,000 — 3,000 added; Nadia's slab in another currency said, not added; Ghost isn't here",
    slabbed.pulled === 1 && items.length === 1 && items[0]!.kind === "addition" && items[0]!.amountMinor === 3_000_00 && /Nadia Okafor \(paid in AED, Sales CRM's slab is INR\)/.test(slabbed.message), slabbed.message);
  check("…named for the CRM, level and slab, the working in its notes", items[0]!.label === "Salary slab — Sales CRM A, AED 15,000.00" && /Contract AED 12,000\.00, this payslip AED 12,000\.00 → AED 15,000\.00/.test(items[0]!.notes), `${items[0]!.label} | ${items[0]!.notes}`);
  let slip = await aishaEarnings();
  check("…on the HRMS payslip as an earning; HRMS still counts 12,000 of it as salary", slip.earnings.some((e) => e.label === items[0]!.label && e.amount === 3_000) && slip.salary?.paid === 12_000);
  slabbed = await adjustments.pullSlabSalaries(orgId, runId, actor);
  check("pulled again, nothing moved: left as it was", slabbed.pulled === 0 && (await slabItems()).length === 1 && /1 as they were/.test(slabbed.message), slabbed.message);

  // A manual item after it, so replacing the slab item can't reuse a counter still in use (HRMS would overwrite it).
  await adjustments.addAdjustments(orgId, runId, [{ lineId: aisha.id, kind: "addition", label: "Phone allowance", amountMinor: 100_00 }], actor);
  slabs.people = onSlab(10_000);
  slabbed = await adjustments.pullSlabSalaries(orgId, runId, actor);
  items = await slabItems();
  check("the slab moved down to 10,000: the 3,000 taken off, 2,000 deducted in its place", items.length === 1 && items[0]!.kind === "deduction" && items[0]!.amountMinor === 2_000_00 && /1 earlier item taken off/.test(slabbed.message), slabbed.message);
  slip = await aishaEarnings();
  check("…HRMS has the deduction, not the old addition; the phone allowance and both commissions still there",
    slip.deductions.some((d) => d.label === items[0]!.label && d.amount === 2_000) && !slip.earnings.some((e) => e.label.startsWith("Salary slab"))
    && slip.earnings.some((e) => e.label === "Phone allowance") && slip.earnings.filter((e) => e.label.startsWith("Sales commission")).length === 2,
    JSON.stringify({ e: slip.earnings.map((e) => e.label), d: slip.deductions.map((d) => d.label) }));
  const ids = (await payroll.getRun(orgId, runId)).adjustments.map((a) => a.externalId);
  check("…every item's id its own", new Set(ids).size === ids.length, ids.join(", "));
  slabs.people = []; slabs.failures = [{ crm: "delta", error: "Its database can't be reached" }];
  slabbed = await adjustments.pullSlabSalaries(orgId, runId, actor);
  check("Root couldn't read the Sales CRM: Aisha's slab item stays, and it says so", (await slabItems()).length === 1 && /Root couldn't read delta/.test(slabbed.message), slabbed.message);
  slabs.failures = [];
  slabbed = await adjustments.pullSlabSalaries(orgId, runId, actor);
  slip = await aishaEarnings();
  check("Aisha no longer on a slab: her item taken off, here and on the payslip", (await slabItems()).length === 0 && !slip.deductions.some((d) => d.label.startsWith("Salary slab")), slabbed.message);
  slabs.people = onSlab(15_000);
  await adjustments.pullSlabSalaries(orgId, runId, actor);
  check("back on 15,000 for the rest of the month: +3,000", (await slabItems())[0]?.amountMinor === 3_000_00);

  run = await payroll.getRun(orgId, runId);
  check("commission written back to the payslip in HRMS",
    run.adjustments.every((a) => a.syncedAt !== null));

  const hrmsAfterCommission = await hrmsClient.payrollBatch(seed.orgId, seed.month);
  const aishaSlip = hrmsAfterCommission.lines.find((l) => l.employeeCode === "E2E001")!;
  check("HRMS payslip shows the commission as an earning",
    aishaSlip.earnings.some((e) => e.label.startsWith("Sales commission")),
    aishaSlip.earnings.map((e) => e.label).join(", "));
  const aishaNow = run.lines.find((l) => l.employeeCode === "E2E001")!;
  check("HRMS net rose to match — the commission, her slab and the allowance", Math.round(aishaSlip.netPay * 100) === aishaNow.payableMinor,
    `HRMS ${aishaSlip.netPay} vs finance ${aishaNow.payableMinor / 100}`);

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

  // Approved by mistake (2026-11-01): one step back — HRMS has it back with accounts — then approved again.
  const undone = await payments.unapproveRun(orgId, runId, "Approved by mistake");
  check("approval undone: back to before it (Additions — it has adjustments)", undone.status === "additions", undone.status);
  const hrmsBack = await hrmsClient.payrollBatch(seed.orgId, seed.month);
  check("…HRMS has the month back with accounts, not with HR", hrmsBack.status === "in_finance", hrmsBack.status);
  let notApproved = "";
  try { await payments.unapproveRun(orgId, runId, "again"); } catch (e) { notApproved = (e as Error).message; }
  check("…undoing it again: refused, it isn't approved", /only an approved run/.test(notApproved), notApproved);
  const reapproved = await payments.approveRun(orgId, runId, actor);
  check("…and approved again, HRMS too", reapproved.status === "approved" && (await hrmsClient.payrollBatch(seed.orgId, seed.month)).status === "approved");

  const paid = await payments.payRun(orgId, runId, {
    bankAccountId: String(bank._id), method: "bank_transfer",
    paidOn: new Date().toISOString().slice(0, 10), reference: "WPS-E2E-001",
  }, actor);
  check("payment recorded", Boolean(paid.paymentId), `${paid.paymentId} ${paid.amountFormatted}`);
  let afterPaid = "";
  try { await payments.unapproveRun(orgId, runId, "too late"); } catch (e) { afterPaid = (e as Error).message; }
  check("undoing the approval once money is paid: refused", /already been paid|only an approved run/.test(afterPaid), afterPaid);
  check("HRMS acknowledged the payment", paid.synced, paid.warning ?? "");
  // One of the three has nothing to transfer: his whole salary went to the
  // advance recovery. Held plus zero-payable leaves exactly one real transfer.
  check("only people actually owed money were paid", paid.paidCount === 1, `${paid.paidCount} paid`);
  check("held person never entered the transfer", paid.heldCount === 1);
  check("commission settled by the payment", paid.commissionsSettled === 2, `${paid.commissionsSettled} records`);
  const crmPaid = await CrmCommissionPayout.findOne({ key: `delta:${seed.month}:crm-aisha` }).lean();
  check("…the CRM commission paid with it: paid through payroll, its run the reference",
    crmPaid?.state === "paid" && crmPaid.paymentMethod === "payroll" && crmPaid.reference === run.runNumber, JSON.stringify({ s: crmPaid?.state, m: crmPaid?.paymentMethod }));
  const csPaid = await CsCommissionPayout.findOne({ key: `bonus:${seed.month}:cs-aisha` }).lean();
  check("…the CS commission too", csPaid?.state === "paid" && csPaid.paymentMethod === "payroll" && csPaid.reference === run.runNumber, JSON.stringify({ s: csPaid?.state }));

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
  // 2026-11-05: posted unpaid and in no account, the expense was marked paid in Expenses and the money left twice.
  const ex = expense as unknown as { _id: unknown; paidOn?: Date; bankAccountId?: unknown; bankTransactionId?: unknown; source?: { kind?: string } };
  check("…paid on the payment's day, in its account, through the payment's own bank line — none of its own",
    !!ex.paidOn && String(ex.bankAccountId) === String(bank._id) && String(ex.bankTransactionId) === String(paid.bankTransactionId) && ex.source?.kind === "payroll"
    && (await BankTransaction.countDocuments({ "matches.type": "expense", "matches.referenceId": String(ex._id) })) === 0,
    JSON.stringify({ paidOn: ex.paidOn, acc: String(ex.bankAccountId), line: String(ex.bankTransactionId), src: ex.source }));
  const expenses = await import("../modules/expense/expense.service");
  const balanceNow = (await BankAccount.findById(bank._id).lean())!.currentBalanceMinor;
  check("…marking it paid in Expenses: refused, it was paid by the payroll payment",
    await refused(expenses.markExpensePaid(orgId, String(ex._id), { paidOn: new Date().toISOString().slice(0, 10), paymentMethod: "bank_transfer" } as never), /paid by payroll .*-P1/));
  check("…marking it unpaid, or voiding it: refused too",
    await refused(expenses.markExpenseUnpaid(orgId, String(ex._id)), /paid by payroll/) && await refused(expenses.voidExpense(orgId, String(ex._id)), /paid by payroll/));
  check("…another amount on it: refused", await refused(expenses.updateExpense(orgId, String(ex._id), { amountMinor: 1 } as never, { all: true } as never), /paid by payroll/));
  await expenses.updateExpense(orgId, String(ex._id), { description: "October payroll" } as never, { all: true } as never);
  await expenses.syncExpenseLine(orgId, ex._id);
  check("…its words can change, and that puts no line of its own in the account: the balance as it was",
    (await Expense.findById(ex._id).lean())?.description === "October payroll" && (await BankAccount.findById(bank._id).lean())!.currentBalanceMinor === balanceNow
    && (await BankTransaction.countDocuments({ "matches.type": "expense" })) === 0);

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
  const crmBack = await CrmCommissionPayout.findOne({ key: `delta:${seed.month}:crm-aisha` }).lean();
  check("…the CRM commission owed again, still on the run", crmBack?.state === "approved" && !crmBack.paymentMethod && crmBack.payrollRunNumber === run.runNumber);
  const csBack = await CsCommissionPayout.findOne({ key: `bonus:${seed.month}:cs-aisha` }).lean();
  check("…the CS commission too", csBack?.state === "approved" && !csBack.paymentMethod && csBack.payrollRunNumber === run.runNumber);
  rootApi.close();

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

  // ── Paid in parts ──────────────────────────────────────────────────────
  step("8. One person paid in parts — part by bank transfer, the rest in cash (2026-11-03)");
  run = await payroll.getRun(orgId, runId);
  check("the run says this API pays in parts", run.payInParts === true);
  const partLine = run.lines.find((l) => l.employeeCode === "E2E001")!;
  const owedMinor = partLine.payableMinor - partLine.amountPaidMinor;
  const firstPart = Math.round(owedMinor * 0.6);
  const today = new Date().toISOString().slice(0, 10);
  const payPart = (amountMinor: number, method: payments.PayInput["method"], reference: string, lineId = partLine.id) =>
    payments.payRun(orgId, runId, { amounts: [{ lineId, amountMinor }], bankAccountId: String(bank._id), method, paidOn: today, reference }, actor);
  const crmKey = `delta:${seed.month}:crm-aisha`;
  const balance = async () => (await BankAccount.findById(bank._id).lean())!.currentBalanceMinor;
  const slipOf = async (code: string) => (await hrmsClient.payrollBatch(seed.orgId, seed.month)).lines.find((l) => l.employeeCode === code)?.status;

  check("more than she is owed: refused whole", await refused(payPart(owedMinor + 1, "bank_transfer", "TOO-MUCH"), /is owed .*Nothing was recorded/));
  check("…no money moved", (await balance()) === 500_000_00, formatMinor(await balance(), "AED"));

  const part1 = await payPart(firstPart, "bank_transfer", "WPS-PART-1");
  check("the bank part recorded: that amount, nobody finished", part1.amountMinor === firstPart && part1.finishedCount === 0, part1.amountFormatted);
  check("…nothing for HRMS to wait on", part1.synced, part1.warning ?? "");
  run = await payroll.getRun(orgId, runId);
  const half = run.lines.find((l) => l.id === partLine.id)!;
  check("…she is part paid, the rest still owed", half.status === "partially_paid" && half.amountPaidMinor === firstPart, half.status);
  check("…the run is part paid", run.status === "partially_paid", run.status);
  check("…her payslip still says issued in HRMS: not all of it is paid", (await slipOf("E2E001")) === "issued");
  check("…her commission isn't settled yet",
    (await CommissionRecord.countDocuments({ status: "earned" })) === 2 && (await CrmCommissionPayout.findOne({ key: crmKey }).lean())?.state === "approved");

  check("the cash part can't be more than what's left", await refused(payPart(owedMinor - firstPart + 1, "cash", "TOO-MUCH-2"), /is owed/));
  const part2 = await payPart(owedMinor - firstPart, "cash", "CASH-PART-2");
  check("the rest in cash: she is finished", part2.finishedCount === 1 && part2.synced, part2.warning ?? "");
  run = await payroll.getRun(orgId, runId);
  const whole = run.lines.find((l) => l.id === partLine.id)!;
  check("…paid in full across the two", whole.status === "paid" && whole.amountPaidMinor === whole.payableMinor);
  check("…each payment its own method and amount",
    run.payments.filter((p) => !p.reversedAt).map((p) => `${p.method}:${p.amountMinor}`).join(",") === `bank_transfer:${firstPart},cash:${owedMinor - firstPart}`);
  check("…her payslip says paid in HRMS now", (await slipOf("E2E001")) === "paid");
  check("…her commission settled with the last part", part2.commissionsSettled === 2 && (await CrmCommissionPayout.findOne({ key: crmKey }).lean())?.state === "paid");
  check("…the account fell by all she was owed", (await balance()) === 500_000_00 - owedMinor, formatMinor(await balance(), "AED"));
  const partExpenses = await Expense.find({ organizationId: org._id, status: "approved" }).lean();
  check("…an expense for each part", partExpenses.map((e) => e.totalMinor).sort((a, b) => (a ?? 0) - (b ?? 0)).join(",") === [firstPart, owedMinor - firstPart].sort((a, b) => a - b).join(","));

  check("the bank part can't be reversed while the cash part that finished her stands",
    await refused(payments.reversePayment(orgId, runId, part1.paymentId, "Bounced"), new RegExp(`finished by ${part2.paymentId}.*reverse that first`)));
  const back2 = await payments.reversePayment(orgId, runId, part2.paymentId, "Wrong cash voucher");
  check("the cash part reversed: her commission owed again", back2.commissionsReopened === 2 && (await CrmCommissionPayout.findOne({ key: crmKey }).lean())?.state === "approved");
  run = await payroll.getRun(orgId, runId);
  check("…she is back to part paid, the bank part kept", run.lines.find((l) => l.id === partLine.id)!.amountPaidMinor === firstPart);
  check("…her payslip back to issued", (await slipOf("E2E001")) === "issued");
  const back1 = await payments.reversePayment(orgId, runId, part1.paymentId, "Bank returned it");
  check("then the bank part: reversed, though HRMS never had it", !back1.alreadyReversed, back1.message);
  run = await payroll.getRun(orgId, runId);
  const none = run.lines.find((l) => l.id === partLine.id)!;
  check("…she is owed in full again", none.status === "pending" && none.amountPaidMinor === 0, none.status);
  check("…the account is back where it was", (await balance()) === 500_000_00, formatMinor(await balance(), "AED"));

  // ── Same day ───────────────────────────────────────────────────────────
  step("9. Two payments the same day: reversing one leaves the other's payslips paid");
  // E2E003 still has no bank details in HRMS: released all the same (2026-11-05) and paid in cash.
  const nadiaReleased = await payments.setLineHold(orgId, runId, e2e003.id, { hold: false }, actor);
  check("somebody with no bank details released to be paid", nadiaReleased.status === "pending" && nadiaReleased.holdReason === "", nadiaReleased.message);
  const byBank = await payPart(owedMinor, "bank_transfer", "WPS-SAME-DAY");
  const byCash = await payments.payRun(orgId, runId, { lineIds: [e2e003.id], bankAccountId: String(bank._id), method: "cash", paidOn: today }, actor);
  check("two payments, the same day, one person each", byBank.finishedCount === 1 && byCash.paidCount === 1 && byCash.synced);
  check("…both payslips say paid", (await slipOf("E2E001")) === "paid" && (await slipOf("E2E003")) === "paid");
  await payments.reversePayment(orgId, runId, byCash.paymentId, "Cash came back");
  check("reversing the cash one: only its payslip goes back to issued", (await slipOf("E2E003")) === "issued");
  check("…the bank one's payslip stays paid", (await slipOf("E2E001")) === "paid", await slipOf("E2E001"));

  // ── The wallet ─────────────────────────────────────────────────────────
  step("10. The wallet: HRMS asks finance what somebody was paid (2026-11-04)");
  // Finance's integration routes as a real server, so HRMS's signed request is checked exactly as in production.
  const { default: express } = await import("express");
  const { default: integrationRoutes } = await import("../modules/integrations/integrations.routes");
  const { errorHandler } = await import("../middleware/errorHandler");
  const finApp = express();
  finApp.use(express.json({ verify: (req, _res, buf) => { (req as typeof req & { rawBody?: Buffer }).rawBody = buf; } }));
  finApp.use("/api/v1/integrations", integrationRoutes);
  finApp.use(errorHandler);
  const finServer = await new Promise<http.Server>((ok) => { const srv = finApp.listen(Number(process.env.E2E_FIN_PORT), "127.0.0.1", () => ok(srv)); });

  const hrmsApi = String(process.env.HRMS_API_URL).replace(/\/+$/, "");
  const loginAs = async (email: string) => {
    const res = await fetch(`${hrmsApi}/api/v1/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "Password123!" }),
    });
    return ((await res.json()) as { data?: { accessToken?: string } }).data?.accessToken ?? "";
  };
  type Wallet = {
    status: string; currency: string; employee: { employeeCode: string };
    totals: { credited: number; deducted: number; net: number; paid: number; balance: number; financePayable: number | null };
    finance: { connected: boolean; error: string | null; crmError: string | null };
    salary: { monthTotal: number; daysInMonth: number };
    days: Array<{ credit: number; counted: boolean }>;
    items: Array<{ label: string; amount: number; group: string; direction: string }>;
    commission: Array<{ source: string; state: string; inBalance: boolean; amount: number; note: string | null }>;
    payments: Array<{ source: string; reference: string; amount: number; reversed: boolean; note: string | null; method: string }>;
  };
  const walletAt = async (token: string, path: string) => {
    const res = await fetch(`${hrmsApi}/api/v1/wallet/${path}`, { headers: { authorization: `Bearer ${token}` } });
    return { status: res.status, wallet: ((await res.json().catch(() => ({}))) as { data?: Wallet }).data };
  };
  const sumOf = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;

  const hrToken = await loginAs(seed.hrEmail);
  check("HR signed in to HRMS", !!hrToken);
  const seedAisha = seed.employees.find((e) => e.code === "E2E001")!;
  const seedNadia = seed.employees.find((e) => e.code === "E2E003")!;
  // Root closed after step 7: the CRMs' commission can't be read, and the wallet says so rather than failing.
  const { wallet: noRoot } = await walletAt(hrToken, `${seedAisha.id}?month=${seed.month}`);
  check("Root down: the wallet opens, says the CRM commission can't be read", !!noRoot?.finance.crmError && !noRoot.commission.some((c) => c.source === "crm"),
    noRoot?.finance.crmError ?? "");
  await new Promise<void>((ok) => rootApi.listen(Number(process.env.E2E_ROOT_PORT), "127.0.0.1", ok));
  const { wallet: w } = await walletAt(hrToken, `${seedAisha.id}?month=${seed.month}`);
  check("HR opens her wallet", w?.employee.employeeCode === "E2E001");
  check("…finance answered HRMS's signed request", w?.finance.connected === true, w?.finance.error ?? "");
  run = await payroll.getRun(orgId, runId);
  const walletLine = run.lines.find((l) => l.id === partLine.id)!;
  check("…what finance owes her is her payroll line", w?.totals.financePayable === walletLine.payableMinor / 100, `${w?.totals.financePayable}`);
  check("…the days, the payslip and finance agree", w?.totals.net === w?.totals.financePayable && !w?.items.some((i) => /differs/.test(i.label)),
    `net ${w?.totals.net}`);
  check("…paid in full, nothing left", w?.status === "paid" && w.totals.paid === walletLine.payableMinor / 100 && w.totals.balance === 0,
    `paid ${w?.totals.paid}, balance ${w?.totals.balance}`);
  check("…a day for every day of the month, adding up to her salary",
    w?.days.length === w?.salary.daysInMonth && sumOf(w!.days.map((d) => d.credit)) === w!.salary.monthTotal, `${w?.salary.monthTotal}`);
  const live = w?.payments.filter((p) => p.source === "payroll" && !p.reversed) ?? [];
  check("…the payment that paid her, with its reference", live.length === 1 && live[0]!.reference === "WPS-SAME-DAY" && live[0]!.amount === owedMinor / 100,
    live.map((p) => `${p.reference}:${p.amount}`).join(","));
  const reversedPays = w?.payments.filter((p) => p.reversed) ?? [];
  check("…the bank and cash parts that were reversed, marked so", ["WPS-PART-1", "CASH-PART-2"].every((r) => reversedPays.some((p) => p.reference === r && /^Reversed/.test(p.note ?? ""))),
    reversedPays.map((p) => p.reference).join(","));
  const crmRow = w?.commission.find((c) => c.source === "crm");
  check("…her CRM commission, carried by payroll and paid with it", crmRow?.state === "paid" && crmRow.inBalance === false && /payroll/.test(crmRow.note ?? ""),
    `${crmRow?.state} · ${crmRow?.note}${w?.finance.crmError ? ` · ${w.finance.crmError}` : ""}`);
  check("…on her payslip as commission once, not counted twice",
    (w?.items.filter((i) => i.group === "commission").length ?? 0) >= 1 && !w?.commission.some((c) => c.inBalance));

  const { wallet: wn } = await walletAt(hrToken, `${seedNadia.id}?month=${seed.month}`);
  const nadiaLine = run.lines.find((l) => l.id === e2e003.id)!;
  check("somebody whose only payment was reversed: all of it still owed",
    wn?.totals.paid === 0 && wn.totals.balance === nadiaLine.payableMinor / 100 && wn.payments.some((p) => p.reversed),
    `balance ${wn?.totals.balance}`);

  const ownToken = await loginAs(seedAisha.email);
  const own = await walletAt(ownToken, `mine?month=${seed.month}`);
  check("she opens her own wallet: the same figures", own.status === 200 && own.wallet?.totals.balance === 0 && own.wallet?.totals.paid === w?.totals.paid);
  check("…but not somebody else's", (await walletAt(ownToken, `${seedNadia.id}?month=${seed.month}`)).status === 403);

  rootApi.close();
  await new Promise<void>((ok) => finServer.close(() => ok()));
  const { wallet: down } = await walletAt(hrToken, `${seedAisha.id}?month=${seed.month}`);
  check("finance down: the wallet still opens and says so", down?.finance.connected === false && /reached|connected/.test(down?.finance.error ?? ""), down?.finance.error ?? "");
  check("…and falls back on what HRMS recorded: paid", down?.status === "paid" && down.payments.length === 1 && /HRMS/.test(down.payments[0]!.note ?? ""),
    `${down?.status}`);

  // ── After approval ─────────────────────────────────────────────────────
  step("11. Additions and deductions after approval, for somebody not paid yet (2026-11-04)");
  run = await payroll.getRun(orgId, runId);
  check("the run is approved and part paid", run.status === "partially_paid", run.status);
  const nadiaBefore = run.lines.find((l) => l.id === e2e003.id)!;
  const aishaPaid = run.lines.find((l) => l.employeeCode === "E2E001")!;
  check("…she is not paid yet, Aisha is", nadiaBefore.status === "pending" && nadiaBefore.amountPaidMinor === 0 && aishaPaid.status === "paid",
    `${nadiaBefore.status} / ${aishaPaid.status}`);
  const slipLine = async (code: string) => (await hrmsClient.payrollBatch(seed.orgId, seed.month)).lines.find((l) => l.employeeCode === code)!;
  const nadiaSlipBefore = await slipLine("E2E003");

  const bonus = await adjustments.addAdjustments(orgId, runId, [{ lineId: e2e003.id, kind: "addition", label: "Late bonus", amountMinor: 500_00 }], actor);
  check("an addition for her after approval: accepted", bonus.outcomes.length === 1);
  run = await payroll.getRun(orgId, runId);
  const nadiaPlus = run.lines.find((l) => l.id === e2e003.id)!;
  check("…her payable rose by it", nadiaPlus.payableMinor === nadiaBefore.payableMinor + 500_00,
    `${formatMinor(nadiaBefore.payableMinor, "AED")} → ${formatMinor(nadiaPlus.payableMinor, "AED")}`);
  const bonusAdj = run.adjustments.find((a) => a.lineId === e2e003.id && a.label === "Late bonus");
  check("…marked as added after approval, and by whom", bonusAdj?.afterApproval === true && !!bonusAdj.createdByName && !!bonusAdj.syncedAt, JSON.stringify(bonusAdj));
  check("…the run stays approved and part paid", run.status === "partially_paid", run.status);
  const nadiaSlipPlus = await slipLine("E2E003");
  check("…her payslip in HRMS carries it, net matching finance",
    nadiaSlipPlus.earnings.some((e) => e.label === "Late bonus" && e.amount === 500) && Math.round(nadiaSlipPlus.netPay * 100) === nadiaPlus.payableMinor,
    `HRMS ${nadiaSlipPlus.netPay} vs finance ${nadiaPlus.payableMinor / 100} (was ${nadiaSlipBefore.netPay})`);
  check("…HRMS still has the month part paid", (await hrmsClient.payrollBatch(seed.orgId, seed.month)).status === "partially_paid");

  const fine = await adjustments.addAdjustments(orgId, runId, [{ lineId: e2e003.id, kind: "deduction", label: "Late fine", amountMinor: 200_00 }], actor);
  run = await payroll.getRun(orgId, runId);
  const nadiaMinus = run.lines.find((l) => l.id === e2e003.id)!;
  check("a deduction for her too: her payable fell by it", fine.outcomes.length === 1 && nadiaMinus.payableMinor === nadiaPlus.payableMinor - 200_00,
    formatMinor(nadiaMinus.payableMinor, "AED"));
  check("…HRMS agrees", Math.round((await slipLine("E2E003")).netPay * 100) === nadiaMinus.payableMinor);

  const aishaSlipBefore = await slipLine("E2E001");
  check("somebody already paid: refused, reverse their payment first",
    await refused(adjustments.addAdjustments(orgId, runId, [{ lineId: aishaPaid.id, kind: "addition", label: "Too late", amountMinor: 100_00 }], actor), /has been paid — reverse their payment first/));
  const aishaItem = run.adjustments.find((a) => a.lineId === aishaPaid.id);
  check("…nor can an item of hers be taken off", !!aishaItem && await refused(adjustments.removeAdjustment(orgId, runId, aishaItem.externalId), /has been paid — reverse their payment first/));
  check("…HRMS refuses a paid payslip itself, asked directly",
    await refused(hrmsClient.applyAdjustments(seed.orgId, seed.month, [{ externalId: `${run.runNumber}:direct:1`, employeeId: aishaPaid.hrmsEmployeeId, kind: "payment", label: "Direct", amount: 1 }]), /already paid/));
  const aishaSlipAfter = await slipLine("E2E001");
  check("…her payslip untouched", aishaSlipAfter.netPay === aishaSlipBefore.netPay && aishaSlipAfter.status === "paid");
  check("pulling commission after approval: still refused", await refused(adjustments.pullCommissions(orgId, runId, actor), /can no longer be adjusted/));

  const fineAdj = run.adjustments.find((a) => a.lineId === e2e003.id && a.label === "Late fine")!;
  await adjustments.removeAdjustment(orgId, runId, fineAdj.externalId);
  run = await payroll.getRun(orgId, runId);
  const nadiaBack = run.lines.find((l) => l.id === e2e003.id)!;
  check("her deduction taken off again: payable back, HRMS too",
    nadiaBack.payableMinor === nadiaPlus.payableMinor && Math.round((await slipLine("E2E003")).netPay * 100) === nadiaBack.payableMinor,
    formatMinor(nadiaBack.payableMinor, "AED"));

  const payNadia = await payments.payRun(orgId, runId, { lineIds: [e2e003.id], bankAccountId: String(bank._id), method: "cash", paidOn: today }, actor);
  check("she is paid what she is owed now, the addition with it", payNadia.amountMinor === nadiaBack.payableMinor && payNadia.synced,
    `${payNadia.amountFormatted} ${payNadia.warning ?? ""}`);
  check("…her payslip says paid", (await slipLine("E2E003")).status === "paid");
  check("…and from now on hers can't change either",
    await refused(adjustments.addAdjustments(orgId, runId, [{ lineId: e2e003.id, kind: "addition", label: "Once more", amountMinor: 100_00 }], actor), /has been paid|can no longer be adjusted/));

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
