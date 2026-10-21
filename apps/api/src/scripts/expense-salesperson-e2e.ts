/**
 * An expense for a salesperson (the user, 2026-10-21: "at expense entry a salesperson to select; it shows on the
 * salesperson's page; picking one marks their department") — finance's services in the test itself.
 *
 * What it proves:
 *   - an expense names its salesperson (their name kept), somebody of this organization only; an edit changes or
 *     clears it, and a save that leaves it out leaves it alone;
 *   - the list filters by salesperson;
 *   - the salesperson's page (people report) counts an expense entered for them as theirs, whoever typed it, and a
 *     claim for nobody as the claimant's — each once — and lists them as "for them" / "own";
 *   - the department stays what the form sends (the form fills it from the salesperson; the server does not guess).
 *
 * Run through scripts/expense-salesperson-e2e.sh (throwaway mongod, no .env anywhere).
 */
import mongoose, { Types } from "mongoose";
import { createExpenseSchema, updateExpenseSchema, expenseQuerySchema } from "@delta/shared";

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
const ex = await import("../modules/expense/expense.service");
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
const ALL = { all: true } as const;

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();

const org = await Organization.create({ name: "Delta HQ E2E", baseCurrency: "AED", lateEntryDays: 0 });
const other = await Organization.create({ name: "Elsewhere E2E", baseCurrency: "AED" });
const ORG = String(org._id);
const role = await Role.create({ organizationId: org._id, key: "accounts", name: "Accounts", permissions: [] });
const sales = await Department.create({ organizationId: org._id, name: "Sales" });
const person = (name: string, o = org) => User.create({
  name, email: `${name.toLowerCase()}@e2e-expsp.test`, passwordHash: "x", status: "active",
  memberships: [{ organizationId: o._id, roleId: role._id, status: "active", departmentId: sales._id }],
});
const farhan = await person("Farhan"), suhail = await person("Suhail"), abshar = await person("Abshar"), stranger = await person("Stranger", other);
const FARHAN = String(farhan._id), SUHAIL = String(suhail._id), ABSHAR = String(abshar._id);
const today = new Date().toISOString().slice(0, 10);
const expense = (by: string, over: Record<string, unknown> = {}) => ex.createExpense(ORG, by, createExpenseSchema.parse({
  category: "travel_transport", subcategory: "fuel", description: "Fuel", expenseDate: today, amountMinor: 10_000, currency: "AED", paymentMethod: "cash", ...over,
}) as never);

/* ── 1 ── */
step("1. An expense names its salesperson");
check("somebody of another organization: refused", /Invalid salesperson/.test(await refusal(expense(FARHAN, { salespersonId: String(stranger._id) }))));
const fuel = await expense(FARHAN, { description: "LC fuel refill", salespersonId: SUHAIL, departmentId: String(sales._id), amountMinor: 53_500 });
check("for Suhail, his name kept, the department the form sent", fuel.salesperson?.id === SUHAIL && fuel.salesperson.name === "Suhail" && fuel.department?.name === "Sales", j({ s: fuel.salesperson, d: fuel.department }));
const nol = await expense(FARHAN, { description: "Nol card recharge", salespersonId: ABSHAR, amountMinor: 18_000 });
const own = await expense(FARHAN, { description: "Farhan's own taxi", amountMinor: 5_000 });
check("an expense for nobody: no salesperson", own.salesperson === null, j(own.salesperson));

/* ── 2 ── */
step("2. Editing it");
let e = await ex.updateExpense(ORG, nol.id, updateExpenseSchema.parse({ description: "Nol card recharge (Oct)" }) as never, ALL);
check("a save that leaves it out leaves it alone", e.salesperson?.id === ABSHAR, j(e.salesperson));
e = await ex.updateExpense(ORG, own.id, updateExpenseSchema.parse({ salespersonId: SUHAIL }) as never, ALL);
check("set on an edit", e.salesperson?.id === SUHAIL);
e = await ex.updateExpense(ORG, own.id, updateExpenseSchema.parse({ salespersonId: "" }) as never, ALL);
check("cleared with \"\"", e.salesperson === null, j(e.salesperson));
check("another organization's person: refused on an edit too", /Invalid salesperson/.test(await refusal(ex.updateExpense(ORG, own.id, updateExpenseSchema.parse({ salespersonId: String(stranger._id) }) as never, ALL))));

/* ── 3 ── */
step("3. The list, one salesperson's");
const listed = await ex.listExpenses(ORG, expenseQuerySchema.parse({ salespersonId: SUHAIL }), ALL);
check("Suhail's: the fuel only", listed.data.map((x) => x.expenseNumber).join() === fuel.expenseNumber, j(listed.data.map((x) => x.expenseNumber)));

/* ── 4 ── */
step("4. The salesperson's page");
const emp = (u: any, code: string) => Employee.create({ organizationId: org._id, hrmsOrgId: "h1", hrmsEmployeeId: code, employeeCode: code, name: u.name, userId: u._id, status: "active", departmentId: sales._id });
const eSuhail = await emp(suhail, "E1"), eFarhan = await emp(farhan, "E2");
const range = { from: today.slice(0, 8) + "01", to: today };
const report = await people.peopleReport(ORG, range as never);
const rowOf = (name: string) => report.rows.find((r: any) => r.name === name);
check("Suhail's cost: the 535 entered for him by Farhan", rowOf("Suhail")?.expensesMinor === 53_500, j(rowOf("Suhail")));
check("Farhan's cost: only his own claim for nobody (50) — not what he entered for others", rowOf("Farhan")?.expensesMinor === 5_000, j(rowOf("Farhan")));
const dSuhail = await people.personDetail(ORG, String(eSuhail._id), range);
check("Suhail's page lists the fuel, \"for them\", entered by Farhan", dSuhail.expenses.length === 1 && dSuhail.expenses[0]!.how === "for" && dSuhail.expenses[0]!.enteredBy === "Farhan", j(dSuhail.expenses));
const dFarhan = await people.personDetail(ORG, String(eFarhan._id), range);
check("Farhan's page: his own claim only, \"own\"", dFarhan.expenses.map((x: any) => [x.description, x.how]).join("|") === "Farhan's own taxi,own", j(dFarhan.expenses));

/* ── 5 ── */
step("5. The department picking a salesperson brings (2026-10-22)");
// Nadia's user has no department of her own; her payroll record (from HRMS) says Marketing.
const marketing = await Department.create({ organizationId: org._id, name: "Marketing" });
const nadia = await User.create({ name: "Nadia", email: "nadia@e2e-expsp.test", passwordHash: "x", status: "active",
  memberships: [{ organizationId: org._id, roleId: role._id, status: "active" }] });
await Employee.create({ organizationId: org._id, hrmsOrgId: "h1", hrmsEmployeeId: "E9", employeeCode: "E9", name: "Nadia", userId: nadia._id, status: "active", departmentId: marketing._id });
const users = await import("../modules/user/user.service");
const { userQuerySchema } = await import("@delta/shared");
const people5 = (await users.listUsers(ORG, userQuerySchema.parse({ page: 1, pageSize: 100 }) as never)).data;
const n = people5.find((u) => u.name === "Nadia"), su = people5.find((u) => u.name === "Suhail"), ab = people5.find((u) => u.name === "Abshar");
check("Nadia: no user department, her payroll record's Marketing", !n?.department && n?.employeeDepartment?.name === "Marketing", j(n));
check("Suhail: his user's Sales, and his payroll record's Sales", su?.department?.name === "Sales" && su?.employeeDepartment?.name === "Sales", j(su));
check("Abshar: no payroll record — none", ab?.employeeDepartment === null, j(ab));

console.log(`\n${checks - failures}/${checks} passed`);
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
