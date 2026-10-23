/**
 * Reconciling a period (the user, 2026-10-23: "reconcile by a specific date — this month, this week, today"), against
 * a scratch database through finance's banking service.
 *
 * What it proves:
 *   - the opening balance a period is offered: the book's running balance before its first day (none reconciled yet),
 *     then the last reconciliation's closing balance when it ended the day before;
 *   - the lines listed: only the period's unreconciled ones — all of them, not 100 — with `earlier` the ones before it;
 *     never another account's;
 *   - opening + ticked = closing balances it; completing reconciles only the ticked lines;
 *   - a period starting on or before the last reconciled day is refused; one open session at a time; the period's last
 *     day after the statement date is refused, and the schema refuses an upside-down period;
 *   - a session started without a period works as before.
 *
 * Run through scripts/reconcile-period-e2e.sh (throwaway mongod, no .env anywhere).
 */
import mongoose, { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}
const banking = await import("../modules/banking/banking.service");
const { BankTransaction } = await import("../modules/banking/bank-transaction.model");
const { startReconciliationSchema, updateReconciliationSchema } = await import("@delta/shared");

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
const acct = (accountName: string) => db.collection("bankaccounts").insertOne({ organizationId: ORG, accountName, accountType: "current", currency: "AED", currentBalanceMinor: 0, openingBalanceMinor: 100_000, openingDate: new Date("2026-01-01"), isActive: true }).then((r) => String(r.insertedId));
const bank = await acct("Delta Bank"), other = await acct("Other Bank");

// The book: opening 1,000.00, then a line a day from 1 Oct; the running balance as the cash book keeps it.
const day = (d: number) => `2026-10-${String(d).padStart(2, "0")}`;
let running = 100_000;
const ids: Record<number, string> = {};
for (let d = 1; d <= 160; d++) {
  const date = new Date(Date.UTC(2026, 9, d)).toISOString().slice(0, 10); // 1 Oct onwards, a line a day
  const amount = d % 3 === 0 ? 5_000 : -1_000;
  running += amount;
  const r = await BankTransaction.create({ organizationId: ORG, accountId: new Types.ObjectId(bank), accountName: "Delta Bank", currency: "AED", date: new Date(`${date}T00:00:00.000Z`), description: `Line ${d}`, reference: "", amountMinor: amount, type: amount < 0 ? "debit" : "credit", runningBalanceMinor: running, source: "manual", status: "unmatched" } as any);
  ids[d] = String(r._id);
}
await BankTransaction.create({ organizationId: ORG, accountId: new Types.ObjectId(other), accountName: "Other Bank", currency: "AED", date: new Date(`${day(5)}T00:00:00.000Z`), description: "Other", reference: "", amountMinor: -500, type: "debit", runningBalanceMinor: 0, source: "manual", status: "unmatched" } as any);
const balAfter = async (d: number) => (await BankTransaction.findById(ids[d]).lean<any>()).runningBalanceMinor as number;

step("1. A period's opening balance");
let o = await banking.reconciliationOpening(org, bank, day(5));
check("nothing reconciled: the book's running balance after 4 Oct", o.source === "book" && o.openingBalanceMinor === await balAfter(4) && o.reconciledTo === null, j(o));
o = await banking.reconciliationOpening(org, bank, "2026-09-01");
check("before any line: the account's opening balance", o.openingBalanceMinor === 100_000, j(o));

step("2. Starting 5–10 Oct");
check("the schema refuses an upside-down period, or only one end", !startReconciliationSchema.safeParse({ statementDate: day(10), statementBalanceMinor: 0, periodFrom: day(10), periodTo: day(5) }).success && !startReconciliationSchema.safeParse({ statementDate: day(10), statementBalanceMinor: 0, periodFrom: day(5) }).success);
let why = await refused(banking.startReconciliation(org, bank, startReconciliationSchema.parse({ statementDate: day(9), statementBalanceMinor: 0, periodFrom: day(5), periodTo: day(10) })), /can't be before the period's last day/);
check("a statement date before the period's last day is refused", !why, why);
const closing = await balAfter(10);
const s1 = await banking.startReconciliation(org, bank, startReconciliationSchema.parse({ statementDate: day(10), statementBalanceMinor: closing, periodFrom: day(5), periodTo: day(10) }));
check("started with its period and the book's opening balance", s1.periodFrom === day(5) && s1.periodTo === day(10) && s1.openingBookBalanceMinor === await balAfter(4) && s1.differenceMinor === closing - await balAfter(4), j(s1));
why = await refused(banking.startReconciliation(org, bank, startReconciliationSchema.parse({ statementDate: day(20), statementBalanceMinor: 0, periodFrom: day(11), periodTo: day(20) })), /open already/);
check("a second one while it is open is refused", !why, why);

step("3. Its lines");
let lines = await banking.reconciliationLines(org, s1.id, false);
check("only 5–10 Oct: 6 lines, oldest first, none of the other account's", lines.length === 6 && lines[0]?.description === "Line 5" && lines.every((l) => l.accountName === "Delta Bank"), j(lines.map((l) => l.description)));
lines = await banking.reconciliationLines(org, s1.id, true);
check("with earlier ones: 1–10 Oct", lines.length === 10 && lines[0]?.description === "Line 1", j(lines.length));

step("4. Ticking and completing");
const period = [5, 6, 7, 8, 9, 10].map((d) => ids[d]!);
let up = await banking.updateReconciliation(org, s1.id, updateReconciliationSchema.parse({ reconciledTransactionIds: period.slice(0, 5) }));
check("five of six ticked: still a difference", up.differenceMinor !== 0, j(up));
up = await banking.updateReconciliation(org, s1.id, updateReconciliationSchema.parse({ reconciledTransactionIds: period }));
check("all six: opening + ticked = closing, balanced", up.differenceMinor === 0, j(up));
const done = await banking.completeReconciliation(org, s1.id, "Accountant");
check("completed", done.status === "completed");
check("only the ticked lines reconciled", (await BankTransaction.countDocuments({ accountId: new Types.ObjectId(bank), isReconciled: true })) === 6);

step("4b. The history list (the Reconcile page's first request)");
let history: any = null;
why = await refused((async () => { history = await banking.listReconciliations(org, bank, { page: 1, pageSize: 5 }); })(), /^$/);
check("lists the sessions without failing", why === "not refused" && history?.data?.length === 1, why);
check("…the completed one with its period", history?.data?.[0]?.periodFrom === day(5) && history?.data?.[0]?.status === "completed", j(history?.data?.[0]));
const ticked = await banking.reconciliationLines(org, s1.id, false, true);
check("its lines (the bank page's panel): the six it reconciled, each with its statement date", ticked.length === 6 && ticked.every((l) => l.isReconciled && l.statementDate === l.date) && ticked[0]?.description === "Line 5", j(ticked.map((l) => [l.description, l.statementDate])));

step("5. The next period");
o = await banking.reconciliationOpening(org, bank, day(11));
check("11 Oct opens at the last reconciliation's closing balance", o.source === "last_reconciliation" && o.openingBalanceMinor === closing && o.reconciledTo === day(10), j(o));
why = await refused(banking.startReconciliation(org, bank, startReconciliationSchema.parse({ statementDate: day(15), statementBalanceMinor: 0, periodFrom: day(10), periodTo: day(15) })), /reconciled up to 2026-10-10 — start the period on 2026-10-11/);
check("a period starting on a reconciled day is refused", !why, why);
const s2 = await banking.startReconciliation(org, bank, startReconciliationSchema.parse({ statementDate: "2027-03-31", statementBalanceMinor: 0, periodFrom: day(11), periodTo: "2027-03-31" }));
lines = await banking.reconciliationLines(org, s2.id, false);
check("a long period lists every line in it — 150, more than the old 100", lines.length === 150, j(lines.length));
lines = await banking.reconciliationLines(org, s2.id, true);
check("…earlier ones never include what is reconciled already", lines.length === 154 && !lines.some((l) => period.includes(l.id)), j(lines.length));

step("6. Without a period, as before");
await db.collection("reconciliationsessions").deleteOne({ _id: new Types.ObjectId(s2.id) });
const old = await banking.startReconciliation(org, other, startReconciliationSchema.parse({ statementDate: day(31), statementBalanceMinor: 0 }));
check("started without a period: no period, every unreconciled line", !old.periodFrom && (await banking.reconciliationLines(org, old.id, false)).length === 1, j(old));

console.log(`\n${checks - failures}/${checks} passed`);
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
