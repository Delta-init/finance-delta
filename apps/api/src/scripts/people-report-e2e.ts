/**
 * Reports → Salesperson (the user, 2026-10-27: "we can't select person … not same sales person … some bugs, fix
 * that") — the people report's services in the test itself.
 *
 * What it proves:
 *   - payroll people keep their rows (current and left alike — the page filters), marked on the payroll;
 *   - a login named on invoices with no payroll record gets a row of its own ("login-<id>"), with what it invoiced
 *     and no payroll cost — so the page's invoiced total is the organization's;
 *   - so does one only owed commission; a login on a payroll record never gets a second row;
 *   - the search finds those rows too; a department filter (payroll people) and the department report leave them out;
 *   - their page: who they are, their invoices, no payslips, the list's figures; a login since put on a payroll
 *     record answers with that record; someone of another organization, or a bad id, is not found.
 *
 * Run through scripts/people-report-e2e.sh (throwaway mongod, no .env anywhere).
 */
import mongoose, { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}

const { Organization } = await import("../modules/organization/organization.model");
const { User } = await import("../modules/user/user.model");
const { Role } = await import("../modules/role/role.model");
const { Department } = await import("../modules/department/department.model");
const { Employee } = await import("../modules/employee/employee.model");
const people = await import("../modules/payroll/people-report.service");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const j = (v: unknown) => JSON.stringify(v).slice(0, 400);
const refusal = async (p: Promise<unknown>) => p.then(() => "", (e: Error) => e.message);

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
const db = mongoose.connection.db!;
await db.dropDatabase();

const org = await Organization.create({ name: "Delta HQ E2E", baseCurrency: "AED" });
const other = await Organization.create({ name: "Elsewhere E2E", baseCurrency: "AED" });
const ORG = String(org._id);
const role = await Role.create({ organizationId: org._id, key: "accounts", name: "Accounts", permissions: [] });
const sales = await Department.create({ organizationId: org._id, name: "Sales" });
const login = (name: string, o = org, status = "active") => User.create({
  name, email: `${name.toLowerCase().replace(/\s+/g, ".")}@e2e-people.test`, passwordHash: "x", status,
  memberships: [{ organizationId: o._id, roleId: role._id, status: "active" }],
});
const jalwa = await login("Jalwa"), admin = await login("Super Admin"), fayis = await login("Fayis");
const owedOnly = await login("Owed Only"), stranger = await login("Stranger", other), gone = await login("Gone Login", org, "suspended");
const linkedLater = await login("Linked Later");

let code = 0;
const employee = (name: string, u: { _id: Types.ObjectId } | null, status = "active") => Employee.create({
  organizationId: org._id, hrmsOrgId: "h1", hrmsEmployeeId: `E${++code}`, employeeCode: `E${code}`, name,
  userId: u?._id ?? null, status, departmentId: sales._id,
});
const eJalwa = await employee("Jalwa", jalwa);
await employee("Abdul Basit", null, "inactive");   // the old record of someone back on the payroll
await employee("Abdul Basit", null);

const today = new Date().toISOString().slice(0, 10);
const range = { from: today.slice(0, 8) + "01", to: today };
let n = 0;
const invoice = (by: { _id: Types.ObjectId; name: string }, totalMinor: number, o = org, status = "sent") => db.collection("invoices").insertOne({
  organizationId: o._id, invoiceNumber: `INV-${++n}`, customerName: `Client ${n}`, salespersonId: by._id, salespersonName: by.name,
  issueDate: new Date(), status, totalMinor, amountPaidMinor: 0, balanceMinor: totalMinor, currency: "AED",
});
await invoice(jalwa, 225_000);
await invoice(admin, 2_000_000);
await invoice(admin, 1_095_000);
await invoice(fayis, 1_102_000);
await invoice(gone, 50_000);
await invoice(admin, 999_900, org, "void");
await invoice(stranger, 77_700, other);
await db.collection("commissionrecords").insertOne({ organizationId: org._id, salespersonId: owedOnly._id, invoiceNumber: "INV-OLD", commissionMinor: 12_500, status: "earned", calculatedAt: new Date() });

/* ── 1 ── */
step("1. The list");
const report = await people.peopleReport(ORG, range, { withLogins: true });
const row = (name: string) => report.rows.filter((r) => r.name === name);
check("Jalwa: one row, on the payroll, her invoice", row("Jalwa").length === 1 && row("Jalwa")[0]!.onPayroll && row("Jalwa")[0]!.invoicedMinor === 225_000, j(row("Jalwa")));
check("Abdul Basit: both records, the old one marked inactive (the page shows current staff by default)",
  row("Abdul Basit").map((r) => r.status).sort().join() === "active,inactive", j(row("Abdul Basit")));
const sa = row("Super Admin")[0];
check("Super Admin: not on the payroll, a login- row, 2 invoices 30,950 (the void one not counted)",
  !!sa && !sa.onPayroll && sa.employeeId === `login-${admin._id}` && sa.invoiceCount === 2 && sa.invoicedMinor === 3_095_000 && sa.payrollPaidMinor === 0, j(sa));
check("Fayis: a row too", row("Fayis")[0]?.invoicedMinor === 1_102_000, j(row("Fayis")));
check("a suspended login: a row, inactive", row("Gone Login")[0]?.status === "inactive", j(row("Gone Login")));
check("owed commission only: a row with what is owed", row("Owed Only")[0]?.commissionOutstandingMinor === 12_500, j(row("Owed Only")));
check("another organization's salesperson: no row", row("Stranger").length === 0);
check("a login with nothing in the range: no row", row("Linked Later").length === 0);
check("invoiced total = every invoice of the organization in the range (not void)", report.totals.invoicedMinor === 225_000 + 3_095_000 + 1_102_000 + 50_000, String(report.totals.invoicedMinor));
check("sorted by name", report.rows.map((r) => r.name).join("|") === [...report.rows.map((r) => r.name)].sort((a, b) => a.localeCompare(b)).join("|"), j(report.rows.map((r) => r.name)));

/* ── 2 ── */
step("2. Search, departments, and callers that ask for payroll people only");
const searched = await people.peopleReport(ORG, { ...range, search: "admin" }, { withLogins: true });
check("search \"admin\": the Super Admin row", searched.rows.map((r) => r.name).join() === "Super Admin", j(searched.rows.map((r) => r.name)));
const byDept = await people.peopleReport(ORG, { ...range, departmentId: String(sales._id) }, { withLogins: true });
check("a department filter: payroll people only", byDept.rows.every((r) => r.onPayroll), j(byDept.rows.map((r) => r.name)));
const plain = await people.peopleReport(ORG, range);
check("without withLogins: payroll people only (as before)", plain.rows.every((r) => r.onPayroll) && plain.rows.length === 3, j(plain.rows.map((r) => r.name)));
const depts = await people.departmentReport(ORG, range);
check("the department report: Sales headcount 3, no logins added", depts.departments.find((d) => d.name === "Sales")?.headcount === 3, j(depts.departments));

/* ── 3 ── */
step("3. A person's page");
const dAdmin = await people.personDetail(ORG, `login-${admin._id}`, range);
check("Super Admin's page: not on payroll, has a login", dAdmin.person.onPayroll === false && dAdmin.person.hasLogin && dAdmin.person.name === "Super Admin", j(dAdmin.person));
check("their 2 invoices, no payslips", dAdmin.invoices.length === 2 && dAdmin.payslips.length === 0, j({ i: dAdmin.invoices.length, p: dAdmin.payslips.length }));
check("the list's figures", dAdmin.summary?.invoicedMinor === 3_095_000 && dAdmin.summary?.employeeId === `login-${admin._id}`, j(dAdmin.summary));
const dJalwa = await people.personDetail(ORG, String(eJalwa._id), range);
check("Jalwa's page: on the payroll, her invoice, her figures", dJalwa.person.onPayroll === true && dJalwa.invoices.length === 1 && dJalwa.summary?.invoicedMinor === 225_000, j(dJalwa.person));
const eLater = await employee("Linked Later", linkedLater);
const dLater = await people.personDetail(ORG, `login-${linkedLater._id}`, range);
check("a login- link to someone since put on payroll: their payroll record", dLater.person.employeeId === String(eLater._id) && dLater.person.onPayroll === true, j(dLater.person));
check("someone of another organization: not found", /not found/i.test(await refusal(people.personDetail(ORG, `login-${stranger._id}`, range))));
check("a bad id: not found", /not found/i.test(await refusal(people.personDetail(ORG, "login-nope", range))) && /not found/i.test(await refusal(people.personDetail(ORG, "nope", range))));
check("an unknown employee id: not found", /not found/i.test(await refusal(people.personDetail(ORG, String(new Types.ObjectId()), range))));

console.log(`\n${checks - failures}/${checks} passed`);
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
