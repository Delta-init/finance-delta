/**
 * Daily Report breakdowns (the user, 2026-10-21: "when we click on stats we can see where it came from") — finance's
 * reports service in the test itself.
 *
 * What it proves:
 *   - income, expenses and revenue broken down over the range and over one day add up to exactly the Daily Report's
 *     own figures — the same invoices (not draft, not void), payments (by paid date), expenses (approved and
 *     submitted, by date);
 *   - each record says what it is and where it opens, and is grouped: income by method, salesperson and CRM; revenue
 *     by salesperson and CRM; expenses by category, department, who submitted it and status;
 *   - the department scope narrows income and revenue to its salespeople, as the report does.
 *
 * Run through scripts/daily-breakdown-e2e.sh (throwaway mongod, no .env anywhere).
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
const { Invoice } = await import("../modules/invoice/invoice.model");
const { Expense } = await import("../modules/expense/expense.model");
const reports = await import("../modules/reports/reports.service");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const j = (v: unknown) => JSON.stringify(v).slice(0, 400);

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();

const org = await Organization.create({ name: "Delta HQ E2E", baseCurrency: "AED" });
const ORG = String(org._id);
const role = await Role.create({ organizationId: org._id, key: "sales", name: "Sales", permissions: [] });
const sales = await Department.create({ organizationId: org._id, name: "Sales" });
const ops = await Department.create({ organizationId: org._id, name: "Operations" });
const person = (name: string, departmentId?: Types.ObjectId) => User.create({
  name, email: `${name.toLowerCase()}@e2e-daily.test`, passwordHash: "x", status: "active",
  memberships: [{ organizationId: org._id, roleId: role._id, status: "active", ...(departmentId ? { departmentId } : {}) }],
});
const anna = await person("Anna", sales._id), omar = await person("Omar", ops._id);

const D1 = "2026-10-05", D2 = "2026-10-06", OUT = "2026-09-20";
const at = (d: string) => new Date(`${d}T10:00:00.000Z`);
let n = 0;
const inv = (o: { by: any; issue: string; total: number; status?: string; crm?: string; source?: string; payments?: Array<{ on: string; amount: number; method: string; receipt?: string }> }) =>
  Invoice.collection.insertOne({
    organizationId: org._id, invoiceNumber: `IN-${String(++n).padStart(5, "0")}`, customerId: new Types.ObjectId(), customerName: `Client ${n}`,
    salespersonId: o.by._id, salespersonName: o.by.name, issueDate: at(o.issue), dueDate: at(o.issue), currency: "AED",
    status: o.status ?? "partial", totalMinor: o.total, balanceMinor: 0, lineItems: [],
    ...(o.crm ? { enrolment: { crm: o.crm } } : {}), ...(o.source ? { external: { source: o.source } } : {}),
    payments: (o.payments ?? []).map((p) => ({ _id: new Types.ObjectId(), paidOn: at(p.on), amountMinor: p.amount, method: p.method, receiptNumber: p.receipt ?? "", reference: "" })),
    createdAt: new Date(), updatedAt: new Date(),
  });
await inv({ by: anna, issue: D1, total: 100_000, crm: "delta", payments: [{ on: D1, amount: 40_000, method: "cash", receipt: "RCT-1" }, { on: D2, amount: 10_000, method: "bank_transfer" }] });
await inv({ by: omar, issue: D1, total: 50_000, payments: [{ on: D1, amount: 50_000, method: "card" }] });
await inv({ by: anna, issue: D2, total: 30_000, crm: "remote", payments: [{ on: OUT, amount: 5_000, method: "cash" }] });
await inv({ by: omar, issue: D2, total: 20_000, status: "void", payments: [{ on: D2, amount: 20_000, method: "cash" }] });
await inv({ by: anna, issue: D2, total: 99_000, status: "draft" });
const exp = (num: string, d: string, total: number, status: string, cat: string, dept?: Types.ObjectId) => Expense.collection.insertOne({
  organizationId: org._id, expenseNumber: num, category: "other", categoryName: cat, description: `${cat} spend`, expenseDate: at(d),
  amountMinor: total, totalMinor: total, currency: "AED", submittedById: anna._id, submittedByName: num === "EXP-3" ? "Omar" : "Anna",
  status, ...(dept ? { departmentId: dept } : {}), createdAt: new Date(), updatedAt: new Date(),
});
await exp("EXP-1", D1, 7_000, "approved", "Fuel", ops._id);
await exp("EXP-2", D1, 3_000, "submitted", "Fuel");
await exp("EXP-3", D2, 12_000, "approved", "Rent", ops._id);
await exp("EXP-4", D2, 9_999, "rejected", "Rent");
await exp("EXP-5", D2, 8_888, "draft", "Rent");

/* ── 1 ── */
step("1. The whole range adds up to the report");
const daily = await reports.getDailyReport(ORG, D1, D2);
const income = await reports.getDailyBreakdown(ORG, "income", D1, D2);
const expense = await reports.getDailyBreakdown(ORG, "expense", D1, D2);
const revenue = await reports.getDailyBreakdown(ORG, "revenue", D1, D2);
check("income = the report's income (payments in range; not the void invoice's, not September's)", income.totalMinor === daily.totals.incomeMinor && income.totalMinor === 100_000 && income.count === 3, j({ b: income.totalMinor, r: daily.totals.incomeMinor }));
check("expenses = the report's (approved and submitted; not rejected, not draft)", expense.totalMinor === daily.totals.expenseMinor && expense.totalMinor === 22_000 && expense.count === 3, j({ b: expense.totalMinor, r: daily.totals.expenseMinor }));
check("revenue = the report's (issued, not draft, not void)", revenue.totalMinor === daily.totals.revenueMinor && revenue.totalMinor === 180_000 && revenue.count === 3, j({ b: revenue.totalMinor, r: daily.totals.revenueMinor }));

/* ── 2 ── */
step("2. One day adds up to its row");
for (const row of daily.rows) {
  const i = await reports.getDailyBreakdown(ORG, "income", row.date, row.date);
  const e = await reports.getDailyBreakdown(ORG, "expense", row.date, row.date);
  const r = await reports.getDailyBreakdown(ORG, "revenue", row.date, row.date);
  check(`${row.date}: income ${row.incomeMinor}, expenses ${row.expenseMinor}, revenue ${row.revenueMinor}`,
    i.totalMinor === row.incomeMinor && e.totalMinor === row.expenseMinor && r.totalMinor === row.revenueMinor, j({ i: i.totalMinor, e: e.totalMinor, r: r.totalMinor }));
}

/* ── 3 ── */
step("3. What each record says, and the groups");
const cashPay = income.records.find((r) => r.number === "RCT-1");
check("a payment: its receipt, client, invoice and method, opening its invoice", !!cashPay && cashPay.title === "Client 1" && cashPay.detail.includes("IN-00001") && cashPay.href.startsWith("/invoices/") && cashPay.date === D1, j(cashPay));
const byMethod = income.groups.find((g) => g.key === "method")!;
check("income by method", j(byMethod.items.map((i) => [i.name, i.amountMinor])) === j([["Card", 50_000], ["Cash", 40_000], ["Bank transfer", 10_000]]), j(byMethod.items));
const byCrm = income.groups.find((g) => g.key === "crm")!;
check("income by CRM — a typed-in invoice says so", byCrm.items.some((i) => i.name === "Sales CRM" && i.amountMinor === 50_000) && byCrm.items.some((i) => i.name === "Typed in finance" && i.amountMinor === 50_000), j(byCrm.items));
check("revenue by salesperson", j(revenue.groups.find((g) => g.key === "salesperson")!.items.map((i) => [i.name, i.amountMinor])) === j([["Anna", 130_000], ["Omar", 50_000]]));
const ex2 = expense.groups;
check("expenses by category, department, who, status", j(ex2.find((g) => g.key === "category")!.items.map((i) => [i.name, i.amountMinor])) === j([["Rent", 12_000], ["Fuel", 10_000]])
  && ex2.find((g) => g.key === "department")!.items.some((i) => i.name === "No department" && i.amountMinor === 3_000)
  && ex2.find((g) => g.key === "status")!.items.some((i) => i.name === "Waiting for approval" && i.count === 1)
  && ex2.find((g) => g.key === "submittedBy")!.items.some((i) => i.name === "Omar"), j(ex2));
check("an expense opens its page", expense.records.every((r) => r.href.startsWith("/expenses/")));
check("newest first", income.records[0]?.date === D2);

/* ── 4 ── */
step("4. A department: income and revenue of its salespeople, as the report");
const dailySales = await reports.getDailyReport(ORG, D1, D2, String(sales._id));
const incSales = await reports.getDailyBreakdown(ORG, "income", D1, D2, String(sales._id));
const revSales = await reports.getDailyBreakdown(ORG, "revenue", D1, D2, String(sales._id));
check("Sales: Anna's payments and invoices only, = the report", incSales.totalMinor === dailySales.totals.incomeMinor && incSales.totalMinor === 50_000
  && revSales.totalMinor === dailySales.totals.revenueMinor && revSales.totalMinor === 130_000, j({ i: incSales.totalMinor, r: revSales.totalMinor, d: dailySales.totals }));
check("expenses stay organization-wide, as the report", (await reports.getDailyBreakdown(ORG, "expense", D1, D2, String(sales._id))).totalMinor === dailySales.totals.expenseMinor);

console.log(`\n${checks - failures}/${checks} passed`);
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
