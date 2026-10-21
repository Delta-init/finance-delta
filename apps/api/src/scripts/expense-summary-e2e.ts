/**
 * The Expenses list's cards (the user, 2026-10-21: "when filtering we can see stats cards — total amount and
 * count — and each currency different") — expenseSummary against a scratch database.
 *
 * What it proves:
 *   - the count is every expense the filters match — the same number the table lists;
 *   - the money is per currency, never added across: total, paid, unpaid (not yet due), overdue;
 *   - voided and rejected expenses are counted but their money left out — unless the status filter asks for them;
 *   - every filter the table has narrows the cards the same way (category, paid/unpaid, dates, search);
 *   - somebody who reads only their own expenses gets only their own figures.
 *
 * Run through scripts/expense-summary-e2e.sh (throwaway mongod, no .env anywhere).
 */
import mongoose, { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}

const { Expense } = await import("../modules/expense/expense.model");
const ex = await import("../modules/expense/expense.service");
const { expenseQuerySchema } = await import("@delta/shared");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const j = (v: unknown) => String(JSON.stringify(v)).slice(0, 600);

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();

const ORG = new Types.ObjectId(), OTHER = new Types.ObjectId();
const me = new Types.ObjectId(), you = new Types.ObjectId();
const today = new Date(new Date().toISOString().slice(0, 10));
const days = (n: number) => new Date(today.getTime() + n * 86_400_000);
let n = 0;
const add = (over: Record<string, unknown>) => Expense.create({
  organizationId: ORG, expenseNumber: `EXP-${++n}`, category: "travel_transport", categoryName: "Travel & Transportation",
  subcategory: "business_taxi", description: `Spend ${n}`, expenseDate: days(-10), amountMinor: 1_000, totalMinor: 1_000,
  currency: "AED", submittedById: me, submittedByName: "Me", status: "approved", ...over,
});
await add({ totalMinor: 10_000, paidOn: days(-9) });                                   // AED paid 100
await add({ totalMinor: 20_000, dueDate: days(5) });                                  // AED unpaid 200
await add({ totalMinor: 30_000, dueDate: days(-2), description: "Office rent", category: "rent_utilities" }); // AED overdue 300
await add({ totalMinor: 40_000 });                                                    // AED unpaid, no due date 400
await add({ totalMinor: 500_000, currency: "INR", paidOn: days(-9) });                 // INR paid 5,000
await add({ totalMinor: 70_000, status: "voided" });                                  // left out
await add({ totalMinor: 80_000, status: "rejected", submittedById: you });            // left out
await add({ totalMinor: 90_000, submittedById: you, paidOn: days(-1), expenseDate: days(-40) }); // AED paid 900 — yours
await Expense.create({ organizationId: OTHER, expenseNumber: "EXP-X", category: "travel_transport", description: "Elsewhere", expenseDate: days(-1),
  amountMinor: 999_999, totalMinor: 999_999, currency: "AED", submittedById: me, submittedByName: "Me", status: "approved" });

const ALL = { all: true } as const;
const q = (over: Record<string, unknown> = {}) => expenseQuerySchema.parse({ page: 1, pageSize: 25, ...over }) as never;
const cur = (s: Awaited<ReturnType<typeof ex.expenseSummary>>, c: string) => s.byCurrency.find((g) => g.currency === c);

/* ── 1 ── */
step("1. No filter");
let s = await ex.expenseSummary(String(ORG), q(), ALL);
const list = await ex.listExpenses(String(ORG), q(), ALL);
check("the count is what the table lists (8), never another organization's", s.count === 8 && list.meta.total === 8, j([s.count, list.meta.total]));
check("2 voided/rejected left out of the money", s.leftOut === 2, String(s.leftOut));
const aed = cur(s, "AED")!, inr = cur(s, "INR")!;
check("AED: 5 expenses, total 1,900, paid 1,000 (2), unpaid 600 (2), overdue 300 (1)",
  aed.count === 5 && aed.totalMinor === 190_000 && aed.paidMinor === 100_000 && aed.paidCount === 2
  && aed.unpaidMinor === 60_000 && aed.unpaidCount === 2 && aed.overdueMinor === 30_000 && aed.overdueCount === 1, j(aed));
check("INR on its own line: 1 paid, 5,000 — never added to AED", inr.count === 1 && inr.totalMinor === 500_000 && inr.paidMinor === 500_000, j(inr));
check("paid + unpaid + overdue = total, each currency", s.byCurrency.every((g) => g.paidMinor + g.unpaidMinor + g.overdueMinor === g.totalMinor));

/* ── 2 ── */
step("2. The table's filters narrow the cards the same way");
s = await ex.expenseSummary(String(ORG), q({ status: "voided" }), ALL);
check("Voided: its money shown", s.count === 1 && s.leftOut === 0 && cur(s, "AED")?.totalMinor === 70_000, j(s));
s = await ex.expenseSummary(String(ORG), q({ paymentStatus: "overdue" }), ALL);
check("Overdue: only the rent", s.count === 1 && cur(s, "AED")?.overdueMinor === 30_000 && !cur(s, "INR"), j(s));
s = await ex.expenseSummary(String(ORG), q({ category: "rent_utilities" }), ALL);
check("a category", s.count === 1 && cur(s, "AED")?.totalMinor === 30_000, j(s));
s = await ex.expenseSummary(String(ORG), q({ q: "office rent" }), ALL);
check("the search", s.count === 1 && cur(s, "AED")?.totalMinor === 30_000, j(s));
s = await ex.expenseSummary(String(ORG), q({ dateFrom: days(-20).toISOString().slice(0, 10) }), ALL);
check("dates: the one 40 days back left out", s.count === 7 && cur(s, "AED")?.totalMinor === 100_000, j(s));
s = await ex.expenseSummary(String(ORG), q({ status: "draft" }), ALL);
check("nothing matched: zero, no currencies", s.count === 0 && s.byCurrency.length === 0 && s.leftOut === 0, j(s));

/* ── 3 ── */
step("3. Only their own");
s = await ex.expenseSummary(String(ORG), q(), { all: false, userId: String(you) } as never);
check("someone who reads only their own: their 2, the rejected one left out of the money", s.count === 2 && s.leftOut === 1 && cur(s, "AED")?.totalMinor === 90_000, j(s));

console.log(`\n${failures ? "\x1b[31m" : "\x1b[32m"}${checks - failures}/${checks} passed\x1b[0m`);
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
