/**
 * Editing, reopening and deleting reconciliations (the user, 2026-10-23: "edit and delete for the reconciliations"),
 * against a scratch database through finance's banking service.
 *
 * What it proves:
 *   - only the latest completed reconciliation is marked undoable; an older one can't be reopened or deleted;
 *   - a completed one: its notes change, its figures don't ("reopen it first");
 *   - reopening: open again with its ticks kept, its lines let go and their statement dates (lines and expenses)
 *     cleared, the account's last reconciled back to the one before; refused while another one is open;
 *   - an open one's period, statement date and balances change with start's checks — not into the last completed one,
 *     not leaving a ticked line or a statement date outside — and the difference is worked out again;
 *   - deleting an open one leaves the lines alone; deleting the latest completed one undoes it, line by line, and a
 *     period can be reconciled again;
 *   - a cash count is never touched here.
 *
 * Run through scripts/reconcile-edit-e2e.sh (throwaway mongod, no .env anywhere).
 */
import mongoose, { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}
const banking = await import("../modules/banking/banking.service");
const { BankTransaction } = await import("../modules/banking/bank-transaction.model");
const { BankAccount } = await import("../modules/banking/bank-account.model");
const { startReconciliationSchema, updateReconciliationSchema, editReconciliationSchema } = await import("@delta/shared");

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
const acct = (accountName: string, accountType = "current") => db.collection("bankaccounts").insertOne({ organizationId: ORG, accountName, accountType, currency: "AED", currentBalanceMinor: 0, openingBalanceMinor: 100_000, openingDate: new Date("2026-01-01"), isActive: true }).then((r) => String(r.insertedId));
const bank = await acct("Delta Bank"), petty = await acct("Delta Petty", "petty_cash");

const day = (d: number) => `2026-10-${String(d).padStart(2, "0")}`;
let running = 100_000;
const ids: Record<number, string> = {};
for (let d = 1; d <= 20; d++) {
  const amount = d % 3 === 0 ? 5_000 : -1_000;
  running += amount;
  const r = await BankTransaction.create({ organizationId: ORG, accountId: new Types.ObjectId(bank), accountName: "Delta Bank", currency: "AED", date: new Date(`${day(d)}T00:00:00.000Z`), description: `Line ${d}`, reference: "", amountMinor: amount, type: amount < 0 ? "debit" : "credit", runningBalanceMinor: running, source: "manual", status: "unmatched" } as any);
  ids[d] = String(r._id);
}
const balAfter = async (d: number) => (await BankTransaction.findById(ids[d]).lean<any>()).runningBalanceMinor as number;
const line = (d: number) => BankTransaction.findById(ids[d]).lean<any>();
// An expense paid by line 2 and one by line 7 — their statement dates follow the reconciliations.
await db.collection("expenses").insertMany([
  { organizationId: ORG, expenseNumber: "EXP-A", bankTransactionId: new Types.ObjectId(ids[2]), statementDate: null },
  { organizationId: ORG, expenseNumber: "EXP-B", bankTransactionId: new Types.ObjectId(ids[7]), statementDate: null },
]);
const expense = (n: string) => db.collection("expenses").findOne({ expenseNumber: n });
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => ids[a + i]!);

async function reconcile(from: number, to: number, statementDates: Record<string, string> = {}) {
  const s = await banking.startReconciliation(org, bank, startReconciliationSchema.parse({ statementDate: day(to), statementBalanceMinor: await balAfter(to), periodFrom: day(from), periodTo: day(to) }));
  await banking.updateReconciliation(org, s.id, updateReconciliationSchema.parse({ reconciledTransactionIds: range(from, to), statementDates }));
  return banking.completeReconciliation(org, s.id, "Accountant");
}
const listed = async () => (await banking.listReconciliations(org, bank, { page: 1, pageSize: 50 })).data;
const account = () => BankAccount.findById(bank).lean<any>();

step("1. Two completed: 1–5 and 6–10 Oct");
const s1 = await reconcile(1, 5, { [ids[2]!]: day(4) });
const s2 = await reconcile(6, 10);
check("both completed, the lines reconciled, EXP-A on the statement on " + day(4), s1.status === "completed" && s2.status === "completed" && (await line(2)).isReconciled && (await expense("EXP-A"))?.statementDate?.toISOString().slice(0, 10) === day(4));
let rows = await listed();
check("the list marks only the latest (6–10) undoable", rows.find((r) => r.id === s2.id)?.undoable === true && rows.find((r) => r.id === s1.id)?.undoable === false, j(rows.map((r) => [r.periodFrom, r.undoable])));
check("…and so does reading one", (await banking.getReconciliation(org, s2.id)).undoable === true && (await banking.getReconciliation(org, s1.id)).undoable === false);

step("2. A completed one: notes only");
const noted = await banking.editReconciliation(org, bank, s1.id, editReconciliationSchema.parse({ notes: "ADCB Oct part 1" }));
check("its notes change", noted.notes === "ADCB Oct part 1" && noted.status === "completed", j(noted));
let why = await refused(banking.editReconciliation(org, bank, s1.id, editReconciliationSchema.parse({ statementBalanceMinor: 1 })), /reopen it first/);
check("its figures don't — reopen it first", !why, why);
why = await refused(banking.editReconciliation(org, bank, s1.id, editReconciliationSchema.parse({ periodFrom: day(1), periodTo: day(4) })), /reopen it first/);
check("…nor its period", !why, why);
check("the schema refuses only one end of a period", !editReconciliationSchema.safeParse({ periodFrom: day(1) }).success);

step("3. The older one can't be undone");
why = await refused(banking.deleteReconciliation(org, bank, s1.id), /Only the latest reconciliation can be deleted \(2026-10-06 → 2026-10-10\)/);
check("deleting 1–5 is refused, naming 6–10", !why, why);
why = await refused(banking.reopenReconciliation(org, bank, s1.id), /Only the latest reconciliation can be reopened/);
check("…reopening it too", !why, why);

step("4. Reopening 6–10");
const balBefore = (await account()).lastReconciledStatementBalanceMinor;
const re = await banking.reopenReconciliation(org, bank, s2.id);
check("open again, its 5 ticks kept, not completed by anyone", re.status === "open" && re.reconciledTransactionIds.length === 5 && !re.completedAt && !re.completedByName, j(re));
check("its lines let go, EXP-B's statement date cleared (pending again)", !(await line(7)).isReconciled && !(await line(7)).reconciledSessionId && (await line(7)).statementDate === null && (await expense("EXP-B"))?.statementDate === null);
check("1–5's lines untouched", (await line(2)).isReconciled === true && !!(await expense("EXP-A"))?.statementDate);
const acc = await account();
check("the account's last reconciled is 1–5's closing balance again", acc.lastReconciledStatementBalanceMinor === s1.statementBalanceMinor && balBefore === s2.statementBalanceMinor, j({ acc: acc.lastReconciledStatementBalanceMinor, s1: s1.statementBalanceMinor }));
rows = await listed();
check("now 1–5 is the undoable one", rows.find((r) => r.id === s1.id)?.undoable === true && rows.find((r) => r.id === s2.id)?.undoable === undefined);
why = await refused(banking.reopenReconciliation(org, bank, s2.id), /open already/);
check("reopening it twice is refused", !why, why);
why = await refused(banking.reopenReconciliation(org, bank, s1.id), /Another reconciliation of this account is open/);
check("reopening 1–5 while 6–10 is open is refused", !why, why);

step("5. Editing the open one");
why = await refused(banking.editReconciliation(org, bank, s2.id, editReconciliationSchema.parse({ periodFrom: day(5), periodTo: day(10) })), /reconciled up to 2026-10-05 — start the period on 2026-10-06/);
check("its period can't reach into 1–5", !why, why);
why = await refused(banking.editReconciliation(org, bank, s2.id, editReconciliationSchema.parse({ periodFrom: day(6), periodTo: day(8) })), /2 ticked lines are after 2026-10-08 — untick them first/);
check("a period leaving 2 ticked lines outside is refused", !why, why);
why = await refused(banking.editReconciliation(org, bank, s2.id, editReconciliationSchema.parse({ statementDate: day(9) })), /can't be before the period's last day/);
check("a statement date before the period's end is refused", !why, why);
let ed = await banking.editReconciliation(org, bank, s2.id, editReconciliationSchema.parse({ statementBalanceMinor: re.statementBalanceMinor + 100 }));
check("closing balance +1.00: the difference is 1.00", ed.differenceMinor === 100, j(ed));
ed = await banking.editReconciliation(org, bank, s2.id, editReconciliationSchema.parse({ openingBalanceMinor: re.openingBookBalanceMinor + 100, statementDate: day(12), notes: "fixed" }));
check("opening +1.00 too: balanced again, statement date and notes changed", ed.differenceMinor === 0 && ed.closingBookBalanceMinor === re.closingBookBalanceMinor + 100 && ed.statementDate === day(12) && ed.notes === "fixed", j(ed));
await banking.updateReconciliation(org, s2.id, updateReconciliationSchema.parse({ reconciledTransactionIds: range(6, 10), statementDates: { [ids[7]!]: day(12) } }));
why = await refused(banking.editReconciliation(org, bank, s2.id, editReconciliationSchema.parse({ statementDate: day(11), periodFrom: day(6), periodTo: day(10) })), /1 line's statement date is after 2026-10-11/);
check("a statement date before a line's statement date is refused", !why, why);
ed = await banking.editReconciliation(org, bank, s2.id, editReconciliationSchema.parse({ periodFrom: day(6), periodTo: day(11) }));
check("its period widened to 6–11", ed.periodTo === day(11) && ed.periodFrom === day(6));
const done2 = await banking.completeReconciliation(org, s2.id, "Accountant");
check("completed again: its lines reconciled, EXP-B on the statement on " + day(12), done2.status === "completed" && (await line(7)).isReconciled && (await expense("EXP-B"))?.statementDate?.toISOString().slice(0, 10) === day(12));

step("6. Deleting");
const s3 = await banking.startReconciliation(org, bank, startReconciliationSchema.parse({ statementDate: day(15), statementBalanceMinor: 0, periodFrom: day(12), periodTo: day(15) }));
await banking.updateReconciliation(org, s3.id, updateReconciliationSchema.parse({ reconciledTransactionIds: range(12, 13) }));
let del = await banking.deleteReconciliation(org, bank, s3.id);
check("an open one: gone, no line let go", del.unreconciled === 0 && !(await listed()).some((r) => r.id === s3.id) && !(await line(12)).isReconciled, j(del));
del = await banking.deleteReconciliation(org, bank, s2.id);
check("the latest completed (6–11): undone — its 5 lines let go", del.unreconciled === 5 && !(await line(8)).isReconciled && (await expense("EXP-B"))?.statementDate === null, j(del));
check("…the account's last reconciled back to 1–5's", (await account()).lastReconciledStatementBalanceMinor === s1.statementBalanceMinor);
del = await banking.deleteReconciliation(org, bank, s1.id);
check("then 1–5: its 5 lines let go, EXP-A pending again", del.unreconciled === 5 && !(await line(2)).isReconciled && (await expense("EXP-A"))?.statementDate === null);
const bare = await account();
check("…nothing reconciled: the account's last reconciled cleared, the list empty", bare.lastReconciledAt === undefined && bare.lastReconciledStatementBalanceMinor === undefined && (await listed()).length === 0, j(bare));
const again = await reconcile(1, 5);
check("1–5 can be reconciled again", again.status === "completed" && (await line(3)).isReconciled);

step("7. A cash count is never touched here");
const count = await banking.recordCashCount(org, petty, { countedOn: day(5), countedMinor: 100_000, notes: "" }, "Accountant");
why = await refused(banking.deleteReconciliation(org, petty, count.id), /cash count/);
check("deleting a count through reconciliations is refused", !why, why);
why = await refused(banking.deleteReconciliation(org, petty, again.id), /not found/);
check("…and another account's reconciliation isn't found", !why, why);

console.log(`\n${checks - failures}/${checks} passed`);
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
