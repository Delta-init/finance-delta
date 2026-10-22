/**
 * The Invoices list's cards and its date range (the user, 2026-10-22: "stat cards like the expenses, with the
 * filters' effect" and "a date range — today, this week, this month, last 30 days, custom") — invoiceListSummary and
 * listInvoices against a scratch database.
 *
 * What it proves:
 *   - the count is every invoice the filters match — the same number the table lists;
 *   - the money is per currency, never added across: invoiced, paid, still owed and, of that, overdue;
 *   - drafts and voided invoices are counted but left out of the money — unless the status filter asks for them;
 *   - every filter narrows the cards as it narrows the table (status, salesperson, search, issue and due dates);
 *   - a "to" date is the whole day: an invoice issued at 15:00 is in its own day ("Today"), for expenses too;
 *   - somebody who reads only their own invoices gets only their own figures.
 *
 * Run through scripts/invoice-list-summary-e2e.sh (throwaway mongod, no .env anywhere).
 */
import mongoose, { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}

const { Invoice } = await import("../modules/invoice/invoice.model");
const { Expense } = await import("../modules/expense/expense.model");
const inv = await import("../modules/invoice/invoice.service");
const ex = await import("../modules/expense/expense.service");
const { invoiceQuerySchema, expenseQuerySchema } = await import("@delta/shared");

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
const anna = new Types.ObjectId(), omar = new Types.ObjectId();
const DAY = "2026-10-20", PREV = "2026-10-19";
const at = (d: string, hh = "00:00") => new Date(`${d}T${hh}:00.000Z`);
let n = 0;
const add = (o: { by?: Types.ObjectId; name?: string; issue?: Date; due?: Date; total: number; paid?: number; status: string; currency?: string; org?: Types.ObjectId }) =>
  Invoice.collection.insertOne({
    organizationId: o.org ?? ORG, invoiceNumber: `IN-${String(++n).padStart(5, "0")}`, customerId: new Types.ObjectId(), customerName: o.name ?? `Client ${n}`,
    salespersonId: o.by ?? anna, salespersonName: (o.by ?? anna) === anna ? "Anna" : "Omar", issueDate: o.issue ?? at(DAY), dueDate: o.due ?? at("2999-01-01"),
    currency: o.currency ?? "AED", status: o.status, totalMinor: o.total, amountPaidMinor: o.paid ?? 0, balanceMinor: o.total - (o.paid ?? 0),
    lineItems: [], payments: [], createdAt: new Date(), updatedAt: new Date(),
  });
await add({ total: 100_000, paid: 100_000, status: "paid" });                                          // AED paid 1,000
await add({ total: 200_000, paid: 50_000, status: "partial", issue: at(DAY, "15:00") });               // AED owes 1,500, issued 15:00
await add({ total: 300_000, status: "sent", due: at(PREV), name: "Late Client" });                     // AED overdue 3,000
await add({ total: 400_000, status: "sent", by: omar });                                               // AED owes 4,000 — Omar
await add({ total: 5_000_000, paid: 1_000_000, status: "partial", currency: "INR" });                 // INR paid 10,000, owes 40,000
await add({ total: 70_000, status: "draft" });                                                         // left out
await add({ total: 80_000, status: "void", by: omar });                                                // left out
await add({ total: 90_000, paid: 90_000, status: "paid", issue: at(PREV) });                           // AED paid 900 — the day before
await add({ total: 999_999, status: "sent", org: OTHER });                                             // another organization

const ALL = { all: true } as const;
const q = (over: Record<string, unknown> = {}) => invoiceQuerySchema.parse({ page: 1, pageSize: 100, ...over }) as never;
const cur = (s: Awaited<ReturnType<typeof inv.invoiceListSummary>>, c: string) => s.byCurrency.find((g) => g.currency === c);
const matches = async (label: string, over: Record<string, unknown>, scope: never = ALL as never) => {
  const [s, list] = await Promise.all([inv.invoiceListSummary(String(ORG), q(over), scope), inv.listInvoices(String(ORG), q(over), scope)]);
  check(`${label}: the cards count what the table lists (${list.meta.total})`, s.count === list.meta.total, j([s.count, list.meta.total]));
  return { s, list };
};

/* ── 1 ── */
step("1. No filter");
let { s, list } = await matches("Everything", {});
check("8 here, never another organization's", s.count === 8 && !list.data.some((r) => r.customerName === `Client 9`), j(s.count));
check("the draft and the voided one counted, left out of the money", s.leftOut === 2, String(s.leftOut));
const aed = cur(s, "AED")!, inr = cur(s, "INR")!;
check("AED: 5 invoices, invoiced 10,900, paid 2,400 (3), owed 8,500 (3), overdue 3,000 (1)",
  aed.count === 5 && aed.totalMinor === 1_090_000 && aed.paidMinor === 240_000 && aed.paidCount === 3
  && aed.balanceMinor === 850_000 && aed.balanceCount === 3 && aed.overdueMinor === 300_000 && aed.overdueCount === 1, j(aed));
check("INR on its own line — never added to AED", inr.count === 1 && inr.totalMinor === 5_000_000 && inr.paidMinor === 1_000_000 && inr.balanceMinor === 4_000_000, j(inr));
check("paid + owed = invoiced, each currency", s.byCurrency.every((g) => g.paidMinor + g.balanceMinor === g.totalMinor));

/* ── 2 ── */
step("2. The table's filters narrow the cards the same way");
({ s } = await matches("Draft", { status: "draft" }));
check("Draft: its money shown when asked for", s.leftOut === 0 && cur(s, "AED")?.totalMinor === 70_000, j(s));
({ s } = await matches("Overdue", { status: "overdue" }));
check("Overdue: the late one, all of it overdue", s.count === 1 && cur(s, "AED")?.overdueMinor === 300_000 && cur(s, "AED")?.balanceMinor === 300_000, j(s));
({ s } = await matches("Omar's", { salespersonId: String(omar) }));
check("One salesperson: Omar's sent one; his voided one left out", s.count === 2 && s.leftOut === 1 && cur(s, "AED")?.totalMinor === 400_000, j(s));
({ s } = await matches("Search", { q: "Late" }));
check("Search: the one it finds", s.count === 1 && cur(s, "AED")?.totalMinor === 300_000, j(s));

/* ── 3 ── */
step("3. A day is the whole day (2026-10-22)");
({ s, list } = await matches("Issued on the day", { issueFrom: DAY, issueTo: DAY }));
check("the one issued at 15:00 is in its own day", list.data.some((r) => r.totalMinor === 200_000), j(list.data.map((r) => r.invoiceNumber)));
check("the day before is not", !list.data.some((r) => r.totalMinor === 90_000) && s.count === 8 - 1, j(s.count));
({ s } = await matches("Due by the day before", { dueTo: PREV }));
check("Due up to a day: the one due that day", s.count === 1 && cur(s, "AED")?.overdueMinor === 300_000, j(s));
({ s } = await matches("Issued the day before", { issueFrom: PREV, issueTo: PREV }));
check("…and only that day's", s.count === 1 && cur(s, "AED")?.paidMinor === 90_000, j(s));

/* ── 4 ── */
step("4. Their own");
({ s } = await matches("Anna's own", {}, { all: false, userId: String(anna) } as never));
check("only Anna's: 6 (her draft among them), Omar's left out", s.count === 6 && s.leftOut === 1 && cur(s, "AED")?.totalMinor === 690_000, j(s));

/* ── 5 ── */
step("5. Expenses: a day is the whole day too");
await Expense.collection.insertOne({ organizationId: ORG, expenseNumber: "EXP-1", category: "other", description: "Taxi", expenseDate: at(DAY, "15:00"),
  amountMinor: 1_000, totalMinor: 1_000, currency: "AED", submittedById: anna, submittedByName: "Anna", status: "approved", createdAt: new Date(), updatedAt: new Date() });
const eq = (over: Record<string, unknown>) => expenseQuerySchema.parse({ page: 1, pageSize: 25, ...over }) as never;
const day = await ex.listExpenses(String(ORG), eq({ dateFrom: DAY, dateTo: DAY }), ALL);
check("an expense at 15:00 is in its own day", day.meta.total === 1, String(day.meta.total));
const before = await ex.listExpenses(String(ORG), eq({ dateTo: PREV }), ALL);
check("…and not in the day before's", before.meta.total === 0, String(before.meta.total));

console.log(`\n${checks - failures}/${checks} passed`);
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
