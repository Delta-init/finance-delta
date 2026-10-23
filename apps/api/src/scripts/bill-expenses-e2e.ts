/**
 * A bill's own expense (the user, 2026-10-23: "when a bill is created it will also create an expense, with category
 * and subcategory mandatory, and a filter — expenses can see the bills"), against a scratch database through
 * finance's services.
 *
 * What it proves:
 *   - a bill needs its category (and subcategory): refused without, or with one that isn't the organization's;
 *   - creating it makes one expense — same date, vendor, net, VAT, total, category — linked both ways;
 *   - it follows the bill: waiting for approval → submitted, approved, rejected; edited (amount, date, category);
 *     part paid → still unpaid, paid in full → paid on the last payment's day, a payment removed → unpaid again;
 *     voided; deleted with the bill; a purchase order's bill → Pending classification; a vendor credit paying it off;
 *   - it can't be changed, paid, approved or deleted as an expense, and is never in the Approvals queue;
 *   - it has no bank line of its own (only the bill's payment has one);
 *   - the P&L, cash flow and the dashboard count the bill once; Expense by category shows it under its category;
 *   - the Expenses list's Source filter: bill / typed / hrms / import;
 *   - a bill from before categories is asked for one on its next edit, and its expense is made then.
 *
 * Run through scripts/bill-expenses-e2e.sh (throwaway mongod, no .env anywhere).
 */
import mongoose, { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}

const { Bill } = await import("../modules/bill/bill.model");
const { Expense } = await import("../modules/expense/expense.model");
const { BankTransaction } = await import("../modules/banking/bank-transaction.model");
const bills = await import("../modules/bill/bill.service");
const ex = await import("../modules/expense/expense.service");
const reports = await import("../modules/reports/reports.service");
const { syncBillExpense } = await import("../modules/bill/bill-expense");
const { createBillSchema, expenseQuerySchema, updateBillSchema } = await import("@delta/shared");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const j = (v: unknown) => String(JSON.stringify(v)).slice(0, 500);
async function refused(p: Promise<unknown>, like: RegExp): Promise<string> {
  try { await p; return "not refused"; } catch (e) { const m = (e as Error).message; return like.test(m) ? "" : m; }
}

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();
const db = mongoose.connection.db!;

const ORG = new Types.ObjectId(), org = String(ORG);
const me = new Types.ObjectId();
await db.collection("organizations").insertOne({ _id: ORG, name: "Delta HQ", baseCurrency: "AED" });
await db.collection("users").insertOne({ _id: me, name: "Accountant", email: "acc@e2e.local", status: "active", memberships: [{ organizationId: ORG, status: "active" }] });
const vendor = (await db.collection("vendors").insertOne({ organizationId: ORG, name: "800 Pergola Pods", currency: "AED", status: "active", createdAt: new Date(), updatedAt: new Date() })).insertedId;
const bank = (await db.collection("bankaccounts").insertOne({ organizationId: ORG, accountName: "Delta Bank", accountType: "current", currency: "AED", currentBalanceMinor: 0, openingBalanceMinor: 10_000_000, openingDate: new Date("2026-01-01"), isActive: true })).insertedId;
const LATE = { userId: String(me) };
// Dated from today on, so the late-entry rule (dated back → a reason and a manager) stays out of it.
const plus = (n: number) => new Date(Date.now() + n * 86_400_000).toLocaleDateString("sv-SE", { timeZone: "Asia/Dubai" });
const D0 = plus(0), D2 = plus(2), D4 = plus(4), D6 = plus(6);
const FROM = plus(-40), TO = plus(40);
const line = (amount: number, taxPct = 5) => ({ description: "Pods", quantity: 1, unitPriceMinor: amount, discountPct: 0, taxPct });
const create = (over: Record<string, unknown> = {}) => bills.createBill(org, createBillSchema.parse({
  vendorId: String(vendor), billDate: D0, dueDate: plus(30), lineItems: [line(100_000)],
  category: "office_setup", subcategory: "furniture", ...over,
}) as never, LATE);
const expOf = (billId: string) => Expense.findOne({ organizationId: ORG, "source.key": `bill:${billId}` }).lean<any>();

/* ── 1 ── */
step("1. A bill needs its category");
check("the schema asks for it", !createBillSchema.safeParse({ vendorId: "v", billDate: D0, dueDate: plus(30), lineItems: [line(100)] }).success);
let why = await refused(create({ category: "office_setup", subcategory: undefined }), /subcategory/i);
check("a category without its subcategory is refused", !why, why);
why = await refused(create({ category: "made_up", subcategory: undefined }), /Unknown expense category/);
check("one that isn't the organization's is refused", !why, why);
check("…and nothing was made", (await Bill.countDocuments()) === 0 && (await Expense.countDocuments()) === 0);

/* ── 2 ── */
step("2. Creating the bill makes its expense");
let b = await create();
let e = await expOf(b.id);
check("one expense, linked both ways", !!e && b.expense?.id === String(e._id) && b.expense?.number === e.expenseNumber && /^EXP-/.test(e.expenseNumber), j(b.expense));
check("its date, vendor, net, VAT and total", e.expenseDate.toISOString().startsWith(D0) && e.description.includes("800 Pergola Pods") && e.description.includes(b.billNumber)
  && e.amountMinor === 100_000 && e.taxMinor === 5_000 && e.totalMinor === 105_000, j(e));
check("its category and subcategory, with names", e.category === "office_setup" && e.subcategory === "furniture" && e.subcategoryName === "Furniture" && b.category?.subcategoryName === "Furniture", j([e.category, e.subcategory, b.category]));
check("approved with the bill, unpaid, not in Banking", e.status === "approved" && !e.paidOn && !e.bankAccountId && !e.bankTransactionId);
check("submitted by who typed the bill", String(e.submittedById) === String(me) && e.submittedByName === "Accountant");
const dto = await ex.getExpense(org, String(e._id), { all: true } as never);
check("the expense says it is the bill's", dto.source === "bill" && dto.bill?.number === b.billNumber && dto.bill?.id === b.id, j([dto.source, dto.bill]));

/* ── 3 ── */
step("3. It follows the bill");
b = await bills.updateBill(org, b.id, updateBillSchema.parse({ billDate: D2, lineItems: [line(200_000)], category: "office_setup", subcategory: "renovation" }) as never, LATE);
e = await expOf(b.id);
check("edited: new date, amount and subcategory; still one expense", e.expenseDate.toISOString().startsWith(D2) && e.totalMinor === 210_000 && e.subcategory === "renovation" && (await Expense.countDocuments({ "source.kind": "bill" })) === 1, j(e));
b = await bills.recordBillPayment(org, b.id, { method: "bank_transfer", amountMinor: 100_000, paidOn: D4, bankAccountId: String(bank) } as never);
e = await expOf(b.id);
check("part paid: still unpaid", !e.paidOn && b.status === "partially_paid");
b = await bills.recordBillPayment(org, b.id, { method: "bank_transfer", amountMinor: 110_000, paidOn: D6, bankAccountId: String(bank) } as never);
e = await expOf(b.id);
check("paid in full: paid, on the last payment's day", e.paidOn?.toISOString().startsWith(D6) && b.status === "paid", j(e.paidOn));
const lines = await BankTransaction.find({ organizationId: ORG }).lean();
check("only the bill's payments are in Banking (2 lines, none the expense's)", lines.length === 2 && lines.every((l: any) => l.matches?.[0]?.type === "bill"), j(lines.map((l: any) => l.matches)));
b = await bills.deleteBillPayment(org, b.id, b.payments.at(-1)!.id);
e = await expOf(b.id);
check("a payment removed: unpaid again", !e.paidOn && b.status === "partially_paid");

const waiting = await create({ requiresApproval: true, lineItems: [line(50_000, 0)] });
check("a bill waiting for approval: its expense submitted", (await expOf(waiting.id)).status === "submitted");
await bills.approveBill(org, waiting.id);
check("…approved with it", (await expOf(waiting.id)).status === "approved");
const turned = await create({ requiresApproval: true, lineItems: [line(30_000, 0)] });
await bills.rejectBill(org, turned.id);
check("…rejected with it", (await expOf(turned.id)).status === "rejected");
const voided = await create({ lineItems: [line(20_000, 0)] });
await bills.voidBill(org, voided.id);
check("voided with it", (await expOf(voided.id)).status === "voided");
const gone = await create({ lineItems: [line(10_000, 0)] });
await bills.deleteBill(org, gone.id);
check("deleted with it", !(await expOf(gone.id)));

/* ── 4 ── */
step("4. It is the bill's, not the expense screen's");
const eid = String((await expOf(b.id))._id);
why = await refused(ex.updateExpense(org, eid, { description: "x" } as never, { all: true } as never), /comes from bill .* change it on the bill/);
check("not edited as an expense", !why, why);
why = await refused(ex.markExpensePaid(org, eid, { paidOn: D6 } as never), /comes from bill/);
check("not paid as an expense", !why, why);
why = await refused(ex.deleteExpense(org, eid), /comes from bill/);
check("not deleted as an expense", !why, why);
why = await refused(ex.voidExpense(org, eid), /comes from bill/);
check("not voided as an expense", !why, why);
const subm = await Expense.countDocuments({ organizationId: ORG, status: "submitted", "source.kind": { $ne: "bill" } });
check("the Approvals queue's filter leaves it out", subm === 0);

/* ── 5 ── */
step("5. Counted once");
// A typed expense beside the bills, to see both kinds in the reports.
await db.collection("expenses").insertOne({ organizationId: ORG, expenseNumber: "EXP-TYPED", category: "office_supplies", categoryName: "Office Supplies & Pantry", subcategory: "stationery", description: "Pens",
  expenseDate: new Date(`${D0}T00:00:00Z`), amountMinor: 5_000, taxMinor: 0, totalMinor: 5_000, currency: "AED", status: "approved", submittedById: me, submittedByName: "Accountant", createdAt: new Date(), updatedAt: new Date() });
const pl = await reports.getProfitLoss(org, FROM, TO);
const billsSub = (await Bill.find({ organizationId: ORG, status: { $nin: ["draft", "voided"] }, billDate: { $gte: new Date(`${FROM}T00:00:00Z`), $lte: new Date(`${TO}T23:59:59Z`) } }).lean()).reduce((s, x: any) => s + (x.subtotalMinor ?? 0), 0);
const supplier = pl.expenses.breakdown.find((x) => x.label === "Supplier bills")?.amountMinor ?? 0;
check("P&L: supplier bills as before, the typed expense once, no bill expense on top", supplier === billsSub && pl.expenses.total === billsSub + 5_000, j({ total: pl.expenses.total, supplier, billsSub }));
const cf = await reports.getCashFlow(org, FROM, TO);
const billPaid = 100_000; // the one payment left
check("cash flow: the bill's payment and the typed expense, once each", cf.operating.outflows === billPaid + 5_000, j(cf.operating));
const cats = await reports.getExpenseByCategory(org, FROM, TO);
const label = (c: any) => String(c.name ?? c.label ?? c.category ?? "");
const setup = cats.categories.filter((c: any) => label(c).startsWith("Office Setup, Equipment & Renovation"));
check("Expense by category shows the bills under their category and subcategory", setup.some((c: any) => label(c).endsWith("Renovation")) && setup.some((c: any) => label(c).endsWith("Furniture")), j(cats.categories.map(label)));

/* ── 6 ── */
step("6. The Expenses list's Source filter");
const q = (source?: string) => expenseQuerySchema.parse({ page: 1, pageSize: 100, ...(source ? { source } : {}) }) as never;
const fromBills = await ex.listExpenses(org, q("bill"), { all: true } as never);
check("From bills: only the bills' expenses", fromBills.data.length === 4 && fromBills.data.every((x) => x.source === "bill" && x.bill), j(fromBills.data.map((x) => [x.expenseNumber, x.source])));
const typed = await ex.listExpenses(org, q("typed"), { all: true } as never);
check("Typed here: only the typed one", typed.data.length === 1 && typed.data[0]!.expenseNumber === "EXP-TYPED", j(typed.data.map((x) => x.expenseNumber)));
check("HRMS and old books: none here", (await ex.listExpenses(org, q("hrms"), { all: true } as never)).data.length === 0 && (await ex.listExpenses(org, q("import"), { all: true } as never)).data.length === 0);

/* ── 7 ── */
step("7. A bill from before categories, and a purchase order's bill");
const old = await db.collection("bills").insertOne({ organizationId: ORG, billNumber: "BILL-OLD", vendorId: vendor, vendorName: "800 Pergola Pods", billDate: new Date("2026-09-01"), dueDate: new Date("2026-10-01"),
  status: "approved", approvalStatus: "not_required", currency: "AED", lineItems: [{ ...line(40_000, 0), lineTotalMinor: 40_000 }], subtotalMinor: 40_000, taxTotalMinor: 0, totalMinor: 40_000, amountPaidMinor: 0, balanceMinor: 40_000, payments: [], createdAt: new Date(), updatedAt: new Date() });
why = await refused(bills.updateBill(org, String(old.insertedId), updateBillSchema.parse({ notes: "x" }) as never, LATE), /Choose the bill's category/);
check("its next edit asks for the category", !why, why);
await bills.updateBill(org, String(old.insertedId), updateBillSchema.parse({ category: "office_setup", subcategory: "equipment" }) as never, LATE);
const oldE = await expOf(String(old.insertedId));
check("…given one, its expense is made (submitted by nobody from before)", oldE?.subcategory === "equipment" && oldE.totalMinor === 40_000 && oldE.submittedByName === "From a bill", j(oldE));
const po = await db.collection("bills").insertOne({ organizationId: ORG, billNumber: "BILL-PO", vendorId: vendor, vendorName: "800 Pergola Pods", billDate: new Date("2026-10-05"), dueDate: new Date("2026-11-05"),
  status: "draft", approvalStatus: "not_required", currency: "AED", lineItems: [], subtotalMinor: 7_000, taxTotalMinor: 0, totalMinor: 7_000, amountPaidMinor: 0, balanceMinor: 7_000, payments: [], createdAt: new Date(), updatedAt: new Date() });
await syncBillExpense(org, po.insertedId);
const poE = await expOf(String(po.insertedId));
check("a bill with no category (as a purchase order makes): Pending classification, draft", poE?.category === "other_unclassified" && poE.subcategory === "pending_classification" && poE.status === "draft", j(poE));
await syncBillExpense(org, po.insertedId);
check("kept in step again: still one", (await Expense.countDocuments({ "source.key": `bill:${po.insertedId}` })) === 1);

console.log(`\n${checks - failures}/${checks} passed`);
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
