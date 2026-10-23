/**
 * An expense's bank statement date (the user, 2026-10-23: "a new field, statement date — the bank statement's date;
 * only at bank reconcile time can we enter it; show it pending on the expense"), against a scratch database through
 * finance's services.
 *
 * What it proves:
 *   - paid from a bank account by card or transfer: its statement date is pending; paid in cash / petty cash, or in
 *     no account: none — the list's badge and its Statement filter agree;
 *   - the expense form can't set it (the schema has no such field);
 *   - reconciling: a date given for a ticked line is kept with the session; one after the statement's own date is
 *     refused; on completing, each ticked line gets its statement date — the one given, else its own date — and so
 *     does its expense (entered); lines not ticked stay pending;
 *   - a line replaced (the expense paid on another day) is no longer on a statement: pending again;
 *   - the backfill script's rule: reconciled bank lines without one get their own date.
 *
 * Run through scripts/statement-date-e2e.sh (throwaway mongod, no .env anywhere).
 */
import mongoose, { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}

const { Expense } = await import("../modules/expense/expense.model");
const { BankTransaction } = await import("../modules/banking/bank-transaction.model");
const ex = await import("../modules/expense/expense.service");
const banking = await import("../modules/banking/banking.service");
const { createExpenseSchema, expenseQuerySchema, updateReconciliationSchema } = await import("@delta/shared");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const j = (v: unknown) => String(JSON.stringify(v)).slice(0, 400);
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
const account = (accountName: string, accountType: string) =>
  db.collection("bankaccounts").insertOne({ organizationId: ORG, accountName, accountType, currency: "AED", currentBalanceMinor: 0, openingBalanceMinor: 10_000_000, openingDate: new Date("2026-01-01"), isActive: true }).then((r) => r.insertedId);
const bank = await account("Delta Bank", "current");
const petty = await account("Delta Petty", "petty_cash");
// Dated from today on, so the late-entry rule stays out of it.
const plus = (n: number) => new Date(Date.now() + n * 86_400_000).toLocaleDateString("sv-SE", { timeZone: "Asia/Dubai" });
const D0 = plus(0), D1 = plus(1), D2 = plus(2), D3 = plus(3), D5 = plus(5);

const expense = (description: string, minor: number, over: Record<string, unknown>) => ex.createExpense(org, String(me), createExpenseSchema.parse({
  category: "office_supplies", subcategory: "stationery", description, expenseDate: D0, amountMinor: minor, currency: "AED", taxPct: 0,
  requiresApproval: false, ...over,
}) as never);
const raw = (id: string) => Expense.findById(id).lean<any>();
const list = async (statement?: "pending" | "entered") =>
  (await ex.listExpenses(org, expenseQuerySchema.parse({ pageSize: 100, ...(statement ? { statement } : {}) }), { all: true } as never)).data;

step("1. Pending, or none");
const card = await expense("Card — Adobe", 7_300, { paymentMethod: "card", bankAccountId: String(bank), paidOn: D0 });
const transfer = await expense("Transfer — Vishnu", 3_600, { paymentMethod: "bank_transfer", bankAccountId: String(bank), paidOn: D1 });
const later = await expense("Card — Google", 10_599, { paymentMethod: "card", bankAccountId: String(bank), paidOn: D2 });
const cash = await expense("Cash — cleaning cloth", 1_450, { paymentMethod: "cash", bankAccountId: String(petty), paidOn: D0 });
const unpaid = await expense("Not paid yet", 5_000, {});
check("a card payment from Delta Bank: pending, with no date", card.statementState === "pending" && !card.statementDate, j(card));
check("a transfer from Delta Bank: pending", transfer.statementState === "pending");
check("cash from petty cash: none", cash.statementState === "none", j(cash));
check("unpaid, in no account: none", unpaid.statementState === "none");
check("the expense form has no statement date to set", !("statementDate" in createExpenseSchema.parse({ category: "office_supplies", description: "x", expenseDate: D0, amountMinor: 1, currency: "AED", statementDate: D0 } as never)));
let pend = (await list("pending")).map((e) => e.expenseNumber).sort();
check("the Statement filter's pending: the three bank ones", pend.join() === [card, transfer, later].map((e) => e.expenseNumber).sort().join(), j(pend));
check("…and entered: none yet", (await list("entered")).length === 0);

step("2. Reconciling");
const lineOf = async (id: string) => String((await raw(id)).bankTransactionId);
const [cardLine, transferLine, laterLine] = [await lineOf(card.id), await lineOf(transfer.id), await lineOf(later.id)];
const session = await banking.startReconciliation(org, String(bank), { statementDate: D3, statementBalanceMinor: 10_000_000 - 7_300 - 3_600, notes: "" } as never);
let why = await refused(banking.updateReconciliation(org, session.id, updateReconciliationSchema.parse({ reconciledTransactionIds: [cardLine], statementDates: { [cardLine]: D5 } })), /can't be after the statement's own date/);
check("a statement date after the statement's own date is refused", !why, why);
check("…a date that isn't YYYY-MM-DD is refused by the schema", !updateReconciliationSchema.safeParse({ reconciledTransactionIds: [], statementDates: { [cardLine]: "19/10/2026" } }).success);
const saved = await banking.updateReconciliation(org, session.id, updateReconciliationSchema.parse({
  reconciledTransactionIds: [cardLine, transferLine], statementDates: { [cardLine]: D2, [transferLine]: D1 /* its own date: not kept */ },
}));
check("the date given for the card line is kept with the session (its own date isn't)", saved.statementDates?.[cardLine] === D2 && !(transferLine in (saved.statementDates ?? {})), j(saved.statementDates));
check("…nothing written to the lines or expenses before completing", !(await BankTransaction.findById(cardLine).lean<any>())?.statementDate && (await raw(card.id)).statementDate === null);
const done = await banking.completeReconciliation(org, session.id, "Accountant");
check("completed", done.status === "completed", j(done));
const [c2, t2, l2] = [await ex.getExpense(org, card.id, { all: true } as never), await ex.getExpense(org, transfer.id, { all: true } as never), await ex.getExpense(org, later.id, { all: true } as never)];
check("the card expense: entered — the statement's day given (paid " + D0 + ", on the statement " + D2 + ")", c2.statementState === "entered" && c2.statementDate === D2 && c2.expenseDate === D0, j(c2));
check("…its line carries it too, reconciled", (await BankTransaction.findById(cardLine).lean<any>())?.statementDate?.toISOString().slice(0, 10) === D2 && (await BankTransaction.findById(cardLine).lean<any>())?.isReconciled === true);
check("the transfer: no date given — its own date", t2.statementState === "entered" && t2.statementDate === D1, j(t2));
check("the one not ticked: still pending", l2.statementState === "pending" && !l2.statementDate);
pend = (await list("pending")).map((e) => e.expenseNumber);
check("the filters agree: pending only the one not ticked, entered the two", pend.join() === later.expenseNumber && (await list("entered")).length === 2, j(pend));
const lineDto = (await banking.listTransactions(org, String(bank), { page: 1, pageSize: 50 } as never)).data.find((t: any) => t.id === cardLine);
check("the bank line's own view shows it", lineDto?.statementDate === D2, j(lineDto));

step("3. A replaced line is not on a statement");
await Expense.updateOne({ _id: later.id }, { $set: { statementDate: new Date(`${D2}T00:00:00.000Z`) } }); // as if it had been reconciled
await Expense.updateOne({ _id: later.id }, { $set: { paidOn: new Date(`${D3}T00:00:00.000Z`) } });
await ex.syncExpenseLine(org, later.id);
const l3 = await raw(later.id);
check("paid on another day: a new line, its statement date gone — pending again", String(l3.bankTransactionId) !== laterLine && l3.statementDate === null, j({ was: laterLine, now: l3.bankTransactionId, sd: l3.statementDate }));

step("4. The backfill's rule");
const old = await expense("Reconciled before statement dates", 2_000, { paymentMethod: "card", bankAccountId: String(bank), paidOn: D0 });
const oldLine = await lineOf(old.id);
await BankTransaction.updateOne({ _id: oldLine }, { $set: { isReconciled: true, reconciledSessionId: "old" } });
const todo = await BankTransaction.find({ accountId: bank, isReconciled: true, statementDate: null }).select("_id").lean();
check("a line reconciled before: the one without a statement date", todo.length === 1 && String(todo[0]?._id) === oldLine, j(todo));
check("…petty cash lines are never asked", (await BankTransaction.countDocuments({ accountId: petty, statementDate: { $ne: null } })) === 0);

console.log(`\n${checks - failures}/${checks} passed`);
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
