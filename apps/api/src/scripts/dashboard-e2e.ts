/**
 * The dashboard (the user, 2026-10-26: fix its figures, a breakdown behind every stat and graph, and the expense's
 * statement date editable), against a scratch database through finance's services.
 *
 * What it proves:
 *   - months are Dubai's: a payment or invoice at 1 am Dubai on the 1st is in that month, not the one before;
 *   - receivables, overdue and aging come from one list: an invoice already marked "overdue" is counted as overdue
 *     (it used not to be), one due today is not;
 *   - payables are bills owed and approved expenses not paid yet — a bill's own expense is its bill, a submitted one
 *     isn't owed yet;
 *   - money out is bill payments and every expense paid — a voided bill's or expense's isn't, nor a bill's own expense
 *     (its bill payment is);
 *   - every breakdown adds up to its figure, and each of its groups adds up to the total;
 *   - an expense breakdown needs report:read or expense:read — someone with invoice:read alone sees the invoice ones;
 *   - an expense's statement date: set by hand, changed, taken off; refused on a voided one and for a non-date.
 *
 * Run through scripts/dashboard-e2e.sh (throwaway mongod, no .env anywhere).
 */
import mongoose, { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}

const dash = await import("../modules/dashboard/dashboard.service");
const ctl = await import("../modules/dashboard/dashboard.controller");
const ex = await import("../modules/expense/expense.service");
const { setExpenseStatementDateSchema } = await import("@delta/shared");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const j = (v: unknown) => String(JSON.stringify(v)).slice(0, 400);

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();
const db = mongoose.connection.db!;
const ORG = new Types.ObjectId(), org = String(ORG);
await db.collection("organizations").insertOne({ _id: ORG, name: "Delta HQ", baseCurrency: "AED" });

// Dubai's this month and last, and instants around the month's start.
const H = 3_600_000, DAY = 86_400_000;
const dubaiNow = new Date(Date.now() + 4 * H);
const y = dubaiNow.getUTCFullYear(), m = dubaiNow.getUTCMonth();
const cur = `${y}-${String(m + 1).padStart(2, "0")}`;
const lastD = new Date(Date.UTC(y, m - 1, 1));
const last = `${lastD.getUTCFullYear()}-${String(lastD.getUTCMonth() + 1).padStart(2, "0")}`;
const monthStart = new Date(Date.UTC(y, m, 1) - 4 * H);       // 00:00 Dubai on the 1st
const earlyFirst = new Date(monthStart.getTime() + H);          // 01:00 Dubai on the 1st — still last month in UTC
const lastMonthDay5 = new Date(Date.UTC(y, m - 1, 5));
const todayDubai = dubaiNow.toISOString().slice(0, 10);
const dayFromToday = (n: number) => new Date(Date.parse(todayDubai) + n * DAY); // date-only, as finance stores due dates
const now = new Date();

const inv = (n: string, o: Record<string, unknown>) => ({
  organizationId: ORG, invoiceNumber: n, customerName: "Client " + n, salespersonName: "Asha", currency: "AED", payments: [],
  totalMinor: 0, subtotalMinor: 0, balanceMinor: 0, createdAt: now, ...o,
});
await db.collection("invoices").insertMany([
  inv("I1", { status: "sent", issueDate: earlyFirst, dueDate: dayFromToday(10), subtotalMinor: 100000, totalMinor: 105000, balanceMinor: 105000 }),
  inv("I2", { status: "overdue", issueDate: lastMonthDay5, dueDate: dayFromToday(-40), subtotalMinor: 200000, totalMinor: 210000, balanceMinor: 50000,
    payments: [{ _id: new Types.ObjectId(), amountMinor: 160000, paidOn: earlyFirst, method: "cash", receiptNumber: "RCT-1" }] }),
  inv("I3", { status: "partial", issueDate: lastMonthDay5, dueDate: dayFromToday(-5), subtotalMinor: 50000, totalMinor: 52500, balanceMinor: 20000, salespersonName: "Ben" }),
  inv("I4", { status: "void", issueDate: earlyFirst, dueDate: dayFromToday(-50), subtotalMinor: 999999, totalMinor: 999999, balanceMinor: 999999,
    payments: [{ _id: new Types.ObjectId(), amountMinor: 5000, paidOn: now, method: "cash" }] }),
  inv("I5", { status: "paid", issueDate: now, dueDate: dayFromToday(0), subtotalMinor: 300000, totalMinor: 315000, balanceMinor: 0,
    payments: [{ _id: new Types.ObjectId(), amountMinor: 315000, paidOn: now, method: "card" }] }),
  inv("I6", { status: "sent", issueDate: now, dueDate: dayFromToday(0), subtotalMinor: 6000, totalMinor: 7000, balanceMinor: 7000 }),
  // Issued at 23:00 Dubai on the last day of last month — UTC still says last month, and so does Dubai.
  inv("I7", { status: "paid", issueDate: new Date(monthStart.getTime() - H), dueDate: dayFromToday(0), subtotalMinor: 4000, totalMinor: 4200, balanceMinor: 0 }),
]);
const bill = (n: string, o: Record<string, unknown>) => ({
  organizationId: ORG, billNumber: n, vendorName: "Vendor " + n, billDate: now, dueDate: dayFromToday(5), currency: "AED", payments: [],
  categoryName: "Office", subcategoryName: "", subtotalMinor: 0, balanceMinor: 0, ...o,
});
await db.collection("bills").insertMany([
  bill("B1", { status: "approved", subtotalMinor: 40000, balanceMinor: 40000, dueDate: dayFromToday(-3) }),
  bill("B2", { status: "partially_paid", subtotalMinor: 30000, balanceMinor: 10000, payments: [{ _id: new Types.ObjectId(), amountMinor: 20000, paidOn: now, method: "bank_transfer" }] }),
  bill("B3", { status: "voided", subtotalMinor: 7777, balanceMinor: 0, payments: [{ _id: new Types.ObjectId(), amountMinor: 7777, paidOn: now, method: "cash" }] }),
]);
const exp = (n: string, o: Record<string, unknown>) => ({
  organizationId: ORG, expenseNumber: n, description: "for " + n, expenseDate: now, currency: "AED", category: "office", categoryName: "Office",
  subcategory: "", subcategoryName: "", submittedByName: "Asha", submittedById: new Types.ObjectId(), attachments: [], paidOn: null, createdAt: now, updatedAt: now, ...o,
});
const expIds = await db.collection("expenses").insertMany([
  exp("E1", { status: "approved", totalMinor: 25000, dueDate: dayFromToday(3) }),
  exp("E2", { status: "approved", totalMinor: 12000, paidOn: now, paymentAccount: "ADCB Current", paymentMethod: "bank_transfer" }),
  exp("E3", { status: "approved", totalMinor: 20000, paidOn: now, source: { kind: "bill" } }),
  exp("E4", { status: "submitted", totalMinor: 8000 }),
  exp("E5", { status: "approved", totalMinor: 3000, category: "employee_advances", categoryName: "Employee Advances Receivable" }),
  exp("E6", { status: "voided", totalMinor: 9999, paidOn: now }),
]).then((r) => r.insertedIds);

step("1. The figures");
const s = await dash.getDashboardStats(org);
check("months are Dubai's this month and last", s.months.current === cur && s.months.last === last, j(s.months));
check("revenue this month counts the invoice issued at 1 am Dubai on the 1st, not 23:00 the day before, nor the void one",
  s.kpi.revenueMtd === 100000 + 300000 + 6000, j(s.kpi.revenueMtd));
check("revenue last month: the two issued on the 5th and the one at 23:00 on its last day", s.kpi.revenueLastMonth === 200000 + 50000 + 4000, j(s.kpi.revenueLastMonth));
check("receivables: every open invoice's balance (void left out)", s.kpi.receivables === 105000 + 50000 + 20000 + 7000, j(s.kpi.receivables));
check("overdue: the one marked \"overdue\" counts too; due today does not", s.kpi.overdueCount === 2 && s.kpi.overdueAmount === 70000, j([s.kpi.overdueCount, s.kpi.overdueAmount]));
check("aging bands add up to receivables", s.aging.current === 112000 && s.aging.band1to30 === 20000 && s.aging.band31to60 === 50000 && s.aging.total === s.kpi.receivables, j(s.aging));
check("payables: bills owed + approved expenses not paid (not the bill's own expense, not a submitted one)",
  s.kpi.payables === 40000 + 10000 + 25000 + 3000 && s.kpi.payablesBills === 50000 && s.kpi.payablesExpenses === 28000, j(s.kpi));
check("net profit: revenue less bills and P&L expenses (no advance, no bill's own expense, no voided)",
  s.kpi.netProfitMtd === 406000 - (40000 + 30000 + 25000 + 12000 + 8000), j(s.kpi.netProfitMtd));
const cf = s.cashflow.find((c) => c.key === cur);
check("cash flow this month: money in includes the payment at 1 am on the 1st, not the void invoice's", cf?.inflowMinor === 160000 + 315000, j(cf));
check("…money out: the bill payment and the expense paid — not the voided bill's, the voided expense, or the bill's own expense", cf?.outflowMinor === 20000 + 12000, j(cf));
check("cash flow has six months, each with its key", s.cashflow.length === 6 && s.cashflow.every((c) => /^\d{4}-\d{2}$/.test(c.key)), j(s.cashflow.map((c) => c.key)));
const off = s.expenseBreakdown.find((e) => e.categoryKey === "office");
check("expense chart: by category, with the key the breakdown asks for — a bill's own expense counted here", off?.totalMinor === 25000 + 12000 + 20000 + 8000, j(s.expenseBreakdown));

step("2. Each breakdown adds up to its figure");
const sumsUp = (b: { totalMinor: number; groups: { items: { amountMinor: number }[] }[] }) =>
  b.groups.every((g) => g.items.reduce((t, i) => t + i.amountMinor, 0) === b.totalMinor);
const cases: [string, Parameters<typeof dash.getDashboardBreakdown>[1], number, number?][] = [
  ["Revenue this month", { kind: "revenue", month: cur }, s.kpi.revenueMtd, 3],
  ["Revenue last month", { kind: "revenue", month: last }, s.kpi.revenueLastMonth, 3],
  ["Receivables", { kind: "receivables" }, s.kpi.receivables, 4],
  ["Overdue", { kind: "overdue" }, s.kpi.overdueAmount, 2],
  ["Aging 31–60", { kind: "aging", band: "31-60" }, s.aging.band31to60, 1],
  ["Aging current", { kind: "aging", band: "current" }, s.aging.current, 2],
  ["Payables", { kind: "payables" }, s.kpi.payables, 4],
  ["Expenses this month (net profit's)", { kind: "expenses", month: cur }, s.kpi.revenueMtd - s.kpi.netProfitMtd, 5],
  ["Money in this month", { kind: "cash_in", month: cur }, cf!.inflowMinor, 2],
  ["Money out this month", { kind: "cash_out", month: cur }, cf!.outflowMinor, 2],
  ["Office category", { kind: "category", category: "office" }, off!.totalMinor, 4],
  ["A top customer", { kind: "customer", customer: "Client I5" }, 300000, 1],
];
for (const [label, q, want, count] of cases) {
  const b = await dash.getDashboardBreakdown(org, q);
  check(`${label}: ${b.totalMinor} = ${want}${count !== undefined ? `, ${count} records` : ""}, every group adds up`,
    b.totalMinor === want && (count === undefined || b.count === count) && sumsUp(b) && b.records.every((r) => r.href.startsWith("/")), j({ total: b.totalMinor, count: b.count, scope: b.scope }));
}
const rev = await dash.getDashboardBreakdown(org, { kind: "revenue", month: cur });
check("a record's date is its Dubai day: I1, at 1 am on the 1st, shows the 1st", rev.records.find((r) => r.number === "I1")?.date === `${cur}-01`, j(rev.records.map((r) => [r.number, r.date])));
const pay = await dash.getDashboardBreakdown(org, { kind: "payables" });
const byType = pay.groups.find((g) => g.key === "type")!.items;
check("payables by type: bills and unpaid expenses", byType.find((i) => i.name === "Bills")?.amountMinor === 50000 && byType.find((i) => i.name === "Unpaid expenses")?.amountMinor === 28000, j(byType));
const due = pay.groups.find((g) => g.key === "due")!.items;
check("…by due: B1 is overdue", due.find((i) => i.name === "Overdue")?.amountMinor === 40000, j(due));
const out = await dash.getDashboardBreakdown(org, { kind: "cash_out", month: cur });
check("money out paid from: the expense's account, the bill payment's method",
  j(out.groups.find((g) => g.key === "paidFrom")!.items.map((i) => i.name).sort()) === j(["ADCB Current", "Bank transfer"].sort()), j(out.groups));
const ageGroups = (await dash.getDashboardBreakdown(org, { kind: "receivables" })).groups.find((g) => g.key === "age")!.items;
check("receivables by age match the aging bands", ageGroups.find((i) => i.name === "31–60 days late")?.amountMinor === 50000 && ageGroups.find((i) => i.name === "Not due yet")?.amountMinor === 112000, j(ageGroups));
const bad = async (q: Parameters<typeof dash.getDashboardBreakdown>[1]) => { try { await dash.getDashboardBreakdown(org, q); return "not refused"; } catch (e) { return (e as Error).message; } };
check("a month that isn't YYYY-MM, an unknown band, no category: refused",
  /YYYY-MM/.test(await bad({ kind: "revenue", month: "Oct" })) && /band/.test(await bad({ kind: "aging", band: "7" })) && /category/.test(await bad({ kind: "category" })));

step("3. Who sees which breakdown");
async function call(perms: string[], query: Record<string, string>): Promise<{ status: string; body?: any }> {
  return new Promise((resolve) => {
    const req = { auth: { organizationId: org, permissions: perms, isSuperAdmin: false }, query } as any;
    const res = { json: (body: unknown) => resolve({ status: "ok", body }), status() { return this; } } as any;
    ctl.getBreakdown(req, res, (e: unknown) => resolve({ status: (e as Error)?.message ?? "error" }));
  });
}
const salesperson = ["invoice:read", "invoice:read:own", "customer:read"];
check("invoice:read alone: revenue and receivables open", (await call(salesperson, { kind: "revenue", month: cur })).status === "ok" && (await call(salesperson, { kind: "receivables" })).status === "ok");
check("…payables, expenses, money out, a category: refused", (await Promise.all([
  call(salesperson, { kind: "payables" }), call(salesperson, { kind: "expenses", month: cur }), call(salesperson, { kind: "cash_out", month: cur }), call(salesperson, { kind: "category", category: "office" }),
])).every((r) => /report:read or expense:read/.test(r.status)));
check("expense:read opens them; so does report:read", (await call(["invoice:read", "expense:read"], { kind: "payables" })).status === "ok" && (await call(["report:read"], { kind: "cash_out", month: cur })).status === "ok");
check("an unknown kind is refused", /kind must be/.test((await call(["report:read"], { kind: "salaries" })).status));

step("4. The expense's statement date, by hand");
const e1 = String(expIds[0]), e6 = String(expIds[5]);
let d = await ex.setExpenseStatementDate(org, e1, { statementDate: "2026-10-20" });
check("set: entered, 2026-10-20", d.statementDate === "2026-10-20" && d.statementState === "entered", j([d.statementDate, d.statementState]));
d = await ex.setExpenseStatementDate(org, e1, { statementDate: "2026-10-22" });
check("changed to 2026-10-22", d.statementDate === "2026-10-22");
d = await ex.setExpenseStatementDate(org, e1, { statementDate: null });
check("taken off: none again (it has no bank line)", !d.statementDate && d.statementState === "none", j([d.statementDate, d.statementState]));
let msg = ""; try { await ex.setExpenseStatementDate(org, e6, { statementDate: "2026-10-20" }); } catch (e) { msg = (e as Error).message; }
check("a voided expense: refused", /voided or rejected/.test(msg), msg);
msg = ""; try { await ex.setExpenseStatementDate(org, String(new Types.ObjectId()), { statementDate: "2026-10-20" }); } catch (e) { msg = (e as Error).message; }
check("another organization's or a missing one: not found", /not found/i.test(msg), msg);
check("the form refuses a non-date, takes null", !setExpenseStatementDateSchema.safeParse({ statementDate: "20/10/2026" }).success && setExpenseStatementDateSchema.safeParse({ statementDate: null }).success);

console.log(`\n${checks - failures}/${checks} passed`);
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
