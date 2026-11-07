/**
 * Reconciling by uploading the bank statement (banking/statement-reconcile.service.ts, the user 2026-11-07), against
 * a scratch database: the statement's lines checked against the account's — matched by reference, by amount within
 * the days allowed (the statement's day kept), an amount that differs with its difference, a line the books lack, a
 * book line the statement lacks — what matched ticked, the difference recorded as a bank charge and paired, a missing
 * line added to the books, "check again" from the lines kept, all matching then reconciled in one go with the
 * statement's days; a petty cash tin refused; and the matcher on its own: one book line never matched twice.
 *
 * Run through scripts/statement-reconcile-e2e.sh (throwaway mongod, no .env anywhere).
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
const st = await import("../modules/banking/statement-reconcile.service");
const { matchStatement, referencesAgree } = await import("../modules/banking/statement-match");
const { createExpenseSchema, checkStatementSchema } = await import("@delta/shared");

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
const account = (accountName: string, accountType: string) =>
  db.collection("bankaccounts").insertOne({ organizationId: ORG, accountName, accountType, currency: "AED", currentBalanceMinor: 10_000_000, openingBalanceMinor: 10_000_000, openingDate: new Date("2026-01-01"), isActive: true }).then((r) => r.insertedId);
const bank = await account("Delta Bank", "current");
const petty = await account("Delta Petty", "petty_cash");
const plus = (n: number) => new Date(Date.now() + n * 86_400_000).toLocaleDateString("sv-SE", { timeZone: "Asia/Dubai" });
const D0 = plus(0), D1 = plus(1), D2 = plus(2), D3 = plus(3);

const paid = (description: string, minor: number, day: string, reference = "") => ex.createExpense(org, String(me), createExpenseSchema.parse({
  category: "office_supplies", subcategory: "stationery", description, expenseDate: day, amountMinor: minor, currency: "AED", taxPct: 0,
  requiresApproval: false, paymentMethod: "bank_transfer", bankAccountId: String(bank), paidOn: day, reference,
}) as never);
const lineOf = async (id: string) => String((await Expense.findById(id).lean<any>()).bankTransactionId);

step("0. The matcher on its own");
check("a reference found in the other's words agrees; a short one doesn't", referencesAgree({ reference: "", description: "POS 0042 TXN-AAA1 Dubai" }, { reference: "TXN-AAA1", description: "x" })
  && !referencesAgree({ reference: "12", description: "" }, { reference: "12", description: "" }));
const twice = matchStatement(
  [{ index: 0, date: D0, amountMinor: -10_000, reference: "", description: "a" }, { index: 1, date: D0, amountMinor: -10_000, reference: "", description: "b" }],
  [{ id: "b1", date: D0, amountMinor: -10_000, reference: "", description: "a" }], { windowDays: 3 });
check("two statement lines of the same amount, one book line: one matched, the other not in the books — never one line twice",
  j(twice.results.map((r) => [r.status, r.bookLineIds])) === j([["matched", ["b1"]], ["not_in_books", []]]), j(twice));
const far = matchStatement([{ index: 0, date: D0, amountMinor: -10_000, reference: "", description: "a" }],
  [{ id: "b1", date: plus(9), amountMinor: -10_000, reference: "", description: "a" }], { windowDays: 3 });
check("…nine days apart: not the same", far.results[0]!.status === "not_in_books" && far.unmatchedBookIds.join() === "b1");

step("1. The books, and a statement");
const pos = await paid("POS — stationery", 50_000, D0, "TXN-AAA1");
const transfer = await paid("Transfer to supplier", 120_000, D1);
const vendor = await paid("Vendor ABC", 350_000, D1);
const cheque = await paid("Unpresented cheque", 9_900, D2);
const deposit = await banking.addTransaction(org, String(bank), { date: D2, description: "Client deposit", reference: "", amountMinor: 200_000, notes: "" } as never);
const [posLine, transferLine, vendorLine, chequeLine] = [await lineOf(pos.id), await lineOf(transfer.id), await lineOf(vendor.id), await lineOf(cheque.id)];
// The statement: 100,000 − 500 − 1,200 − 3,536.75 + 2,000 − 15.75 = 96,747.50.
const closing = 10_000_000 - 50_000 - 120_000 - 353_675 + 200_000 - 1_575;
const session = await banking.startReconciliation(org, String(bank), { statementDate: D3, statementBalanceMinor: closing, periodFrom: D0, periodTo: D3, openingBalanceMinor: 10_000_000, notes: "" } as never);
const statement = checkStatementSchema.parse({ fileName: "adcb-statement.csv", lines: [
  { date: D0, description: "POS 0042 TXN-AAA1", reference: "", amountMinor: -50_000, balanceMinor: 9_950_000 },
  { date: D2, description: "Transfer", reference: "", amountMinor: -120_000, balanceMinor: 9_830_000 },        // posted a day after the books
  { date: D1, description: "Vendor ABC payment", reference: "", amountMinor: -353_675, balanceMinor: 9_476_325 }, // 36.75 more: a charge
  { date: D2, description: "Client deposit", reference: "", amountMinor: 200_000, balanceMinor: 9_676_325 },
  { date: D3, description: "Monthly service fee", reference: "", amountMinor: -1_575, balanceMinor: closing },  // not in the books
] });

step("2. Checked");
let r = await st.checkStatement(org, String(bank), session.id, statement);
const by = (i: number) => r.check.lines.find((l) => l.index === i)!;
check("by its reference: the POS line", by(0).status === "matched" && by(0).bookLines[0]?.id === posLine, j(by(0)));
check("by its amount, a day later: the transfer — the statement's day kept for it", by(1).status === "matched" && by(1).bookLines[0]?.id === transferLine
  && r.session.statementDates?.[transferLine] === D2, j({ l: by(1), d: r.session.statementDates }));
check("the vendor: amount differs — books 3,500.00, statement 3,536.75, difference −36.75", by(2).status === "amount_differs" && by(2).bookLines[0]?.id === vendorLine && by(2).differenceMinor === -3_675, j(by(2)));
check("the deposit: matched", by(3).status === "matched" && by(3).bookLines[0]?.id === deposit.id);
check("the service fee: not in the books", by(4).status === "not_in_books" && !by(4).bookLines.length);
check("the cheque: in the books, not on the statement", r.check.notOnStatement.map((b) => b.id).join() === chequeLine, j(r.check.notOnStatement));
check("what matched is ticked, nothing else", [...r.session.reconciledTransactionIds].sort().join() === [posLine, transferLine, deposit.id].sort().join(), j(r.session.reconciledTransactionIds));
check("the summary: 3 matched, 1 differs, 1 missing, 1 extra; the file's closing balance agrees", j([r.check.summary.matched, r.check.summary.amountDiffers, r.check.summary.notInBooks, r.check.summary.notOnStatement, r.check.summary.closingAgrees])
  === j([3, 1, 1, 1, true]) && !r.check.allMatch, j(r.check.summary));
check("…what doesn't agree comes to 36.75 + 15.75 − 99.00 the other way", r.check.summary.unexplainedMinor === -3_675 - 1_575 + 9_900, String(r.check.summary.unexplainedMinor));
check("…kept with the reconciliation", !!(await banking.getReconciliation(org, session.id)).statementCheck);

step("3. Putting it right");
r = await st.recordStatementDifference(org, String(bank), session.id, 2, String(me));
const charge = await Expense.findOne({ organizationId: ORG, category: "bank_fees", totalMinor: 3_675 }).lean<any>();
check("the difference as a Bank Charges expense: 36.75, paid from the account on the statement's day", !!charge && charge.subcategory === "bank_charges" && charge.paidOn?.toISOString().slice(0, 10) === D1, j(charge));
check("…the vendor line and the charge together match the statement line", by(2).status === "matched" && by(2).bookLines.map((b) => b.id).sort().join() === [vendorLine, String(charge?.bankTransactionId)].sort().join(), j(by(2)));
check("a statement showing more coming in isn't a charge: refused", !(await refused(st.recordStatementDifference(org, String(bank), session.id, 3, String(me)), /Only a line whose amount differs/)));
r = await st.addStatementLineToBooks(org, String(bank), session.id, 4, String(me), {});
const fee = await Expense.findOne({ organizationId: ORG, category: "bank_fees", totalMinor: 1_575 }).lean<any>();
check("the service fee added to the books — a Bank Charges expense on its day — and matched now", !!fee && fee.paidOn?.toISOString().slice(0, 10) === D3 && by(4).status === "matched", j({ fee, l: by(4) }));
check("…only once: in the books already, refused", !(await refused(st.addStatementLineToBooks(org, String(bank), session.id, 4, String(me), {}), /in the books already/)));
check("still not all: the cheque the statement doesn't have", !r.check.allMatch && r.check.notOnStatement.length === 1 && r.session.differenceMinor === 0, j({ s: r.check.summary, d: r.session.differenceMinor }));
await ex.markExpenseUnpaid(org, cheque.id);
r = await st.checkStatement(org, String(bank), session.id, {} as never);
check("the cheque wasn't paid after all — checked again from the statement kept: everything matches, the difference nil", r.check.allMatch && r.session.differenceMinor === 0 && r.check.summary.matched === 5, j({ s: r.check.summary, d: r.session.differenceMinor }));

step("4. Reconciled in one go");
const done = await banking.completeReconciliation(org, session.id, "Accountant");
check("completed", done.status === "completed");
const tline = await BankTransaction.findById(transferLine).lean<any>();
check("each matched line reconciled with the statement's day — the transfer on " + D2 + ", its expense too",
  tline?.isReconciled && tline.statementDate?.toISOString().slice(0, 10) === D2 && (await Expense.findById(transfer.id).lean<any>())?.statementDate?.toISOString().slice(0, 10) === D2, j(tline));
check("a completed reconciliation isn't checked again", !(await refused(st.checkStatement(org, String(bank), session.id, statement), /completed/)));

step("5. Not a petty cash tin");
const tin = await banking.startReconciliation(org, String(petty), { statementDate: D3, statementBalanceMinor: 0, notes: "" } as never);
check("a statement for petty cash: refused — it is counted", !(await refused(st.checkStatement(org, String(petty), tin.id, statement), /petty cash/)));

console.log(`\n${checks - failures}/${checks} passed`);
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
