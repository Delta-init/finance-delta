/**
 * The reports and the dashboard with money in other currencies beside them (the user, 2026-11-26: "fix the same
 * currency mixing in the dashboard and the other reports too"): in an organization that keeps its books in dirhams, an
 * invoice, a bill, an expense or a payment in rupees is out of every figure — payments received and made, what is owed
 * either way and its aging, the invoice summary, the balance sheet, the cash flow, sales by item, expenses by
 * category, the Profit & Loss's income, and the dashboard's cards, charts and breakdowns — and is given apart, as
 * recorded: a line per currency and figure, never converted. Run through scripts/reports-other-currency-e2e.sh
 * (throwaway mongod).
 */
import mongoose, { Types } from "mongoose";
import type { OtherCurrencyLine } from "@delta/shared";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) { console.error(`Refusing: ${uri}`); process.exit(1); }
const reports = await import("../modules/reports/reports.service");
const { getDashboardStats, getDashboardBreakdown } = await import("../modules/dashboard/dashboard.service");
let failures = 0, checks = 0;
const check = (label: string, ok: boolean, detail = "") => { checks++; if (ok) console.log(`  ✓ ${label}`); else { failures++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); } };
const j = (v: unknown) => String(JSON.stringify(v)).slice(0, 700);
/** A report's other-currency lines as "CUR|what|amount|count", sorted — or "" when it has none. */
const apartOf = (r: { otherCurrencies?: OtherCurrencyLine[] }) => (r.otherCurrencies ?? []).map((l) => `${l.currency}|${l.what}|${l.amountMinor}|${l.count}`).sort().join(" ; ");

await mongoose.connect(uri);
await mongoose.connection.db!.dropDatabase();
const db = mongoose.connection.db!;
const HQ = new Types.ObjectId();
await db.collection("organizations").insertMany([{ _id: HQ, name: "Organization One", baseCurrency: "AED" }]);
await db.collection("expensecategories").insertMany([
  { organizationId: HQ, name: "Rent", slug: "rent", inPnl: true, subcategories: [] },
  { organizationId: HQ, name: "Marketing", slug: "marketing", inPnl: true, subcategories: [] },
]);
// This month, whatever month the test runs in: the dashboard counts the month it is.
const ym = new Date().toISOString().slice(0, 7);
const at = (day: number) => new Date(`${ym}-${String(day).padStart(2, "0")}T08:00:00.000Z`);
const from = `${ym}-01`, to = `${ym}-28`;
const A = new Types.ObjectId(), B = new Types.ObjectId(), V1 = new Types.ObjectId(), V2 = new Types.ObjectId(), S1 = new Types.ObjectId();

await db.collection("invoices").insertMany([
  // Dirhams: 10,500 (10,000 before VAT), 4,200 paid, 6,300 owed.
  { organizationId: HQ, invoiceNumber: "IN-1", status: "partial", currency: "AED", issueDate: at(3), dueDate: at(27), customerId: A, customerName: "Client A", salespersonId: S1, salespersonName: "Person One",
    subtotalMinor: 1_000_000, totalMinor: 1_050_000, amountPaidMinor: 420_000, balanceMinor: 630_000,
    lineItems: [{ description: "Course X", quantity: 1, lineSubtotalMinor: 1_000_000 }], payments: [{ _id: new Types.ObjectId(), amountMinor: 420_000, paidOn: at(3), method: "card" }], createdAt: at(3) },
  // Rupees in the dirham organization: 50,000, 20,000 paid, 30,000 owed.
  { organizationId: HQ, invoiceNumber: "IN-2", status: "partial", currency: "INR", issueDate: at(5), dueDate: at(27), customerId: B, customerName: "Client B", salespersonId: S1, salespersonName: "Person One",
    subtotalMinor: 5_000_000, totalMinor: 5_000_000, amountPaidMinor: 2_000_000, balanceMinor: 3_000_000,
    lineItems: [{ description: "Course Y", quantity: 1, lineSubtotalMinor: 5_000_000 }], payments: [{ _id: new Types.ObjectId(), amountMinor: 2_000_000, paidOn: at(6), method: "bank_transfer" }], createdAt: at(5) },
]);
await db.collection("bills").insertMany([
  { organizationId: HQ, billNumber: "BILL-1", status: "approved", currency: "AED", billDate: at(8), dueDate: at(27), vendorId: V1, vendorName: "Vendor One",
    subtotalMinor: 70_000, totalMinor: 73_500, balanceMinor: 43_500, payments: [{ _id: new Types.ObjectId(), amountMinor: 30_000, paidOn: at(9) }] },
  { organizationId: HQ, billNumber: "BILL-2", status: "approved", currency: "INR", billDate: at(9), dueDate: at(27), vendorId: V2, vendorName: "Vendor Two",
    subtotalMinor: 800_000, totalMinor: 800_000, balanceMinor: 500_000, payments: [{ _id: new Types.ObjectId(), amountMinor: 300_000, paidOn: at(10) }] },
]);
const exp = (day: number, minor: number, category: string, extra: Record<string, unknown> = {}) =>
  ({ organizationId: HQ, status: "approved", expenseDate: at(day), totalMinor: minor, category, source: { kind: "manual" }, paidOn: null, ...extra });
await db.collection("expenses").insertMany([
  exp(6, 120_000, "rent", { currency: "AED", paidOn: at(7), expenseNumber: "EXP-1" }),
  exp(10, 80_000, "marketing", { currency: "AED", expenseNumber: "EXP-2" }),
  exp(11, 2_000_000, "rent", { currency: "INR", expenseNumber: "EXP-3" }),
]);
const org = String(HQ);

console.log("\nReceivables");
const received = await reports.getReceivedPayments(org, from, to);
check("payments received: dirhams 4,200; the rupee payment apart", received.totalMinor === 420_000 && apartOf(received) === "INR|Payments received|2000000|1", j(received));
const agedIn = await reports.getAgedReceivables(org);
check("aged receivables: 6,300 owed, one invoice listed; the rupee invoice apart", agedIn.totals.grand === 630_000 && agedIn.current.length + agedIn.band1to30.length + agedIn.band31to60.length + agedIn.band61to90.length + agedIn.band90plus.length === 1 && apartOf(agedIn) === "INR|Still owed|3000000|1", j([agedIn.totals, agedIn.otherCurrencies]));
const summary = await reports.getInvoiceSummary(org, from, to, "customer");
check("invoice summary: Client A 10,500 alone; Client B's rupees apart", summary.items.length === 1 && summary.items[0]?.label === "Client A" && summary.items[0]?.totalMinor === 1_050_000 && apartOf(summary) === "INR|Invoiced|5000000|1", j(summary));

console.log("\nPayables");
const made = await reports.getMadePayments(org, from, to);
check("payments made: dirhams 300 to one vendor; the rupee payment apart", made.totalMinor === 30_000 && made.byVendor.length === 1 && apartOf(made) === "INR|Payments made|300000|1", j(made));
const agedOut = await reports.getAgedPayables(org);
check("aged payables: 435 owed; the rupee bill apart", agedOut.totals.grand === 43_500 && apartOf(agedOut) === "INR|Still owed|500000|1", j([agedOut.totals, agedOut.otherCurrencies]));

console.log("\nStatements");
const sheet = await reports.getBalanceSheet(org, to);
check("balance sheet: receivable 6,300, payable 435, equity 5,865", sheet.assets.accountsReceivable === 630_000 && sheet.liabilities.accountsPayable === 43_500 && sheet.equity === 586_500, j(sheet));
check("balance sheet: rupees owed either way are apart, each under its own figure", apartOf(sheet) === "INR|Accounts payable|500000|1 ; INR|Accounts receivable|3000000|1", apartOf(sheet));
const flow = await reports.getCashFlow(org, from, to);
check("cash flow: in 4,200, out 300 + 2,000 = 2,300, net 1,900", flow.operating.inflows === 420_000 && flow.operating.outflows === 230_000 && flow.netChange === 190_000, j(flow));
check("cash flow: rupees in and out are apart — in 20,000; out 3,000 + 20,000 over two records", apartOf(flow) === "INR|Money in|2000000|1 ; INR|Money out|2300000|2", apartOf(flow));
const pl = await reports.getProfitLoss(org, from, to);
check("profit and loss: income 10,000 in dirhams; the rupee invoice apart", pl.income.total === 1_000_000 && apartOf(pl.income) === "INR|Invoice revenue|5000000|1", j(pl.income));
check("profit and loss: expenses 2,700 and net 7,300 as before; rupee costs apart", pl.expenses.total === 270_000 && pl.netProfitMinor === 730_000 && pl.expenses.otherCurrencies?.[0]?.amountMinor === 2_800_000, j(pl.expenses));

console.log("\nOther reports");
const sales = await reports.getSalesByItem(org, from, to);
check("sales by item: Course X 10,000 alone; Course Y's rupees apart", sales.items.length === 1 && sales.grandTotalMinor === 1_000_000 && apartOf(sales) === "INR|Sales|5000000|1", j(sales));
const byCategory = await reports.getExpenseByCategory(org, from, to);
check("expenses by category: Rent 1,200 and Marketing 800 = 2,000; the rupee rent apart, not a second Rent line", byCategory.grandTotalMinor === 200_000 && byCategory.categories.length === 2 && apartOf(byCategory) === "INR|Expenses|2000000|1", j(byCategory));

console.log("\nThe dashboard");
const dash = await getDashboardStats(org);
check("revenue this month 10,000; net profit 10,000 − 2,700 = 7,300", dash.kpi.revenueMtd === 1_000_000 && dash.kpi.netProfitMtd === 730_000, j(dash.kpi));
check("receivables 6,300; payables 435 + 800 = 1,235", dash.kpi.receivables === 630_000 && dash.kpi.payables === 123_500 && dash.kpi.payablesBills === 43_500 && dash.kpi.payablesExpenses === 80_000, j(dash.kpi));
check("what the cards leave out, each under its own figure", apartOf(dash) === "INR|Expenses this month|2800000|2 ; INR|Payables|2500000|2 ; INR|Receivables|3000000|1 ; INR|Revenue this month|5000000|1", apartOf(dash));
const thisMonth = dash.cashflow.find((m) => m.key === ym);
check("cash flow chart, this month: in 4,200, out 300 + 1,200 = 1,500 — dirhams only", thisMonth?.inflowMinor === 420_000 && thisMonth?.outflowMinor === 150_000, j(thisMonth));
check("top customers and the expense chart are dirhams only", j(dash.topCustomers.map((c) => [c.name, c.revenueMinor])) === j([["Client A", 1_000_000]]) && j(dash.expenseBreakdown.map((e) => [e.categoryKey, e.totalMinor])) === j([["rent", 120_000], ["marketing", 80_000]]), j([dash.topCustomers, dash.expenseBreakdown]));
check("recent invoices list both, each with its own currency", j(dash.recentInvoices.map((i) => [i.number, i.currency]).sort()) === j([["IN-1", "AED"], ["IN-2", "INR"]]), j(dash.recentInvoices));
const behind = await getDashboardBreakdown(org, { kind: "revenue", month: ym });
check("behind the revenue card: one dirham invoice, 10,000; the rupee one apart", behind.count === 1 && behind.totalMinor === 1_000_000 && (behind.otherCurrencies ?? []).length === 1 && behind.otherCurrencies?.[0]?.amountMinor === 5_000_000, j([behind.totalMinor, behind.count, behind.otherCurrencies]));

console.log(`\n${checks - failures}/${checks} checks passed`);
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
