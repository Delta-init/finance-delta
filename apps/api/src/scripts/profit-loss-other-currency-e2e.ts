/**
 * The Profit & Loss with expenses in other currencies beside it (the user, 2026-11-26: "fix finance's profit and loss
 * so rupee expenses are not added into AED"): an expense or a supplier bill in rupees in an organization that keeps
 * its books in dirhams is out of Total Expenses, their breakdown and the net profit, and given apart, as recorded — a
 * line per currency, never converted; one with no currency on it is the organization's; what is not a profit-and-loss
 * expense, a draft, a rejected one and a bill's own expense are left out as before; the period before is worked out
 * the same way; and an organization that keeps its books in rupees counts its rupees as its own. Run through
 * scripts/profit-loss-other-currency-e2e.sh (throwaway mongod).
 */
import mongoose, { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) { console.error(`Refusing: ${uri}`); process.exit(1); }
const { getProfitLoss } = await import("../modules/reports/reports.service");
let failures = 0, checks = 0;
const check = (label: string, ok: boolean, detail = "") => { checks++; if (ok) console.log(`  ✓ ${label}`); else { failures++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); } };
const j = (v: unknown) => String(JSON.stringify(v)).slice(0, 700);

await mongoose.connect(uri);
await mongoose.connection.db!.dropDatabase();
const db = mongoose.connection.db!;
const HQ = new Types.ObjectId(), BLR = new Types.ObjectId();
await db.collection("organizations").insertMany([
  { _id: HQ, name: "Organization One", baseCurrency: "AED" },
  { _id: BLR, name: "Organization Two", baseCurrency: "INR" },
]);
// One category that is recorded but is not a profit-and-loss expense; the rest are seeded by the service.
await db.collection("expensecategories").insertMany([
  { organizationId: HQ, name: "Rent", slug: "rent", inPnl: true, subcategories: [] },
  { organizationId: HQ, name: "Marketing", slug: "marketing", inPnl: true, subcategories: [] },
  { organizationId: HQ, name: "Salary advance", slug: "advance", inPnl: false, subcategories: [] },
  { organizationId: BLR, name: "Rent", slug: "rent", inPnl: true, subcategories: [] },
]);
const at = (d: string) => new Date(`${d}T08:00:00.000Z`);
const exp = (org: Types.ObjectId, on: string, minor: number, category: string, extra: Record<string, unknown> = {}) =>
  ({ organizationId: org, status: "approved", expenseDate: at(on), totalMinor: minor, category, source: { kind: "manual" }, ...extra });

await db.collection("invoices").insertMany([
  { organizationId: HQ, invoiceNumber: "IN-1", status: "paid", issueDate: at("2026-11-03"), subtotalMinor: 1_000_000, totalMinor: 1_050_000, currency: "AED" },
  { organizationId: HQ, invoiceNumber: "IN-2", status: "draft", issueDate: at("2026-11-04"), subtotalMinor: 999_900, totalMinor: 999_900, currency: "AED" },
  { organizationId: HQ, invoiceNumber: "IN-3", status: "paid", issueDate: at("2026-10-10"), subtotalMinor: 400_000, totalMinor: 420_000, currency: "AED" },
]);
await db.collection("expenses").insertMany([
  // November, the organization's own currency: 1,200 + 500 + 300 (no currency on it) = 2,000.
  exp(HQ, "2026-11-06", 120_000, "rent", { currency: "AED" }),
  exp(HQ, "2026-11-10", 50_000, "marketing", { currency: "AED", status: "submitted" }),
  exp(HQ, "2026-11-12", 30_000, "marketing"),
  // Rupees and dollars in the dirham organization: apart.
  exp(HQ, "2026-11-18", 2_000_000, "rent", { currency: "INR" }),
  exp(HQ, "2026-11-19", 500_000, "marketing", { currency: "inr" }),
  exp(HQ, "2026-11-20", 10_000, "marketing", { currency: "USD" }),
  // Left out as before: not a profit-and-loss expense, a draft, a rejected one, a bill's own expense.
  exp(HQ, "2026-11-21", 40_000, "advance", { currency: "AED" }),
  exp(HQ, "2026-11-21", 999_900, "rent", { currency: "AED", status: "draft" }),
  exp(HQ, "2026-11-21", 888_800, "rent", { currency: "AED", status: "rejected" }),
  exp(HQ, "2026-11-08", 70_000, "rent", { currency: "AED", source: { kind: "bill" } }),
  // The period before (October): dirhams 1,000 and rupees 10,000.
  exp(HQ, "2026-10-20", 100_000, "rent", { currency: "AED" }),
  exp(HQ, "2026-10-21", 1_000_000, "rent", { currency: "INR" }),
  // The rupee organization: its rupees are its own; a dirham expense there is the one apart.
  exp(BLR, "2026-11-05", 3_000_000, "rent", { currency: "INR" }),
  exp(BLR, "2026-11-06", 20_000, "rent", { currency: "AED" }),
]);
await db.collection("bills").insertMany([
  { organizationId: HQ, billNumber: "BILL-1", status: "open", billDate: at("2026-11-08"), subtotalMinor: 70_000, totalMinor: 73_500, currency: "AED" },
  { organizationId: HQ, billNumber: "BILL-2", status: "open", billDate: at("2026-11-09"), subtotalMinor: 800_000, totalMinor: 800_000, currency: "INR" },
  { organizationId: HQ, billNumber: "BILL-3", status: "draft", billDate: at("2026-11-09"), subtotalMinor: 555_500, totalMinor: 555_500, currency: "AED" },
]);

const NOV = ["2026-11-01", "2026-11-30"] as const;
const hq = await getProfitLoss(String(HQ), ...NOV);
const lines = (rows: { label: string; amountMinor: number }[]) => Object.fromEntries(rows.map((r) => [r.label, r.amountMinor]));
const other = Object.fromEntries((hq.expenses.otherCurrencies ?? []).map((o) => [o.currency, o]));

console.log("\nThe dirham organization, November");
check("total expenses are the dirhams only: bill 700 + expenses 2,000 = 2,700 (the old sum gave 35,800)", hq.expenses.total === 270_000, j(hq.expenses.total));
check("the breakdown is dirhams only: Supplier bills 700, Rent 1,200, Marketing 800", j(lines(hq.expenses.breakdown)) === j({ "Supplier bills": 70_000, Rent: 120_000, Marketing: 80_000 }), j(hq.expenses.breakdown));
check("net profit is income 10,000 less 2,700 = 7,300", hq.income.total === 1_000_000 && hq.netProfitMinor === 730_000, j([hq.income.total, hq.netProfitMinor]));
check("two other currencies, apart, in order: INR then USD", j((hq.expenses.otherCurrencies ?? []).map((o) => o.currency)) === j(["INR", "USD"]), j(hq.expenses.otherCurrencies));
check("rupees as recorded: 33,000 over 3 — the bill 8,000, rent 20,000, marketing 5,000 (typed in lower case too)", other.INR?.amountMinor === 3_300_000 && other.INR?.count === 3 && j(lines(other.INR?.breakdown ?? [])) === j({ "Supplier bills": 800_000, Rent: 2_000_000, Marketing: 500_000 }), j(other.INR));
check("dollars as recorded: 100 over 1", other.USD?.amountMinor === 10_000 && other.USD?.count === 1, j(other.USD));
check("nothing is converted: no other-currency amount is in the total, whatever the mix", hq.expenses.total + (other.INR?.amountMinor ?? 0) + (other.USD?.amountMinor ?? 0) === 3_580_000, j(hq.expenses));

console.log("\nThe period before");
check("it is October, worked out as before", hq.prior?.from === "2026-10-01" && hq.prior?.to === "2026-10-31", j([hq.prior?.from, hq.prior?.to]));
check("its expenses are the dirhams only: 1,000; net 4,000 less 1,000 = 3,000", hq.prior?.expenses.total === 100_000 && hq.prior?.netProfitMinor === 300_000, j(hq.prior));
check("its rupees are apart too: INR 10,000 over 1", j((hq.prior?.expenses.otherCurrencies ?? []).map((o) => [o.currency, o.amountMinor, o.count])) === j([["INR", 1_000_000, 1]]), j(hq.prior?.expenses.otherCurrencies));

console.log("\nA period with dirhams only");
const first = await getProfitLoss(String(HQ), "2026-11-01", "2026-11-08");
check("no other-currency list at all when there is none: bill 700 + rent 1,200 = 1,900", first.expenses.total === 190_000 && first.expenses.otherCurrencies === undefined, j(first.expenses));

console.log("\nThe rupee organization");
const blr = await getProfitLoss(String(BLR), ...NOV);
check("its rupees are its own: 30,000 in the total", blr.expenses.total === 3_000_000, j(blr.expenses));
check("the dirham expense there is the one apart: AED 200 over 1", j((blr.expenses.otherCurrencies ?? []).map((o) => [o.currency, o.amountMinor, o.count])) === j([["AED", 20_000, 1]]), j(blr.expenses.otherCurrencies));

console.log(`\n${checks - failures}/${checks} checks passed`);
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
