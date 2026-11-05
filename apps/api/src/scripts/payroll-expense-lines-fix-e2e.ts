/**
 * scripts/payroll-expense-lines-fix.ts (the user, 2026-11-05: a payroll payment's money out of the account twice — its
 * own line and its expense's), against a scratch database.
 *
 * Seeded as the bug left them: a payment whose expense was marked paid and got a line of its own; one never marked
 * paid (unpaid, in no account); a reversed one whose voided expense kept its own line; one whose own line was
 * reconciled against a bank statement; one posted the new way, already right.
 *
 * What it proves: the dry run lists each, says which took the money twice, leaves the reconciled one, writes nothing;
 * --expect guards; --write takes the expenses' own lines out, links each expense to its payment's line, paid on its
 * day in its account, and the account's balance and running balances are worked out again; a second run has nothing
 * left but the reconciled one; the undo puts every line and expense back as it was.
 *
 * Run through scripts/payroll-expense-lines-fix-e2e.sh (throwaway mongod, no .env anywhere).
 */
import mongoose, { Types } from "mongoose";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}
const { fixPayrollExpenseLines, undoPayrollExpenseLines } = await import("./payroll-expense-lines-fix");
const { recalculateRunningBalances } = await import("../modules/banking/banking.service");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const show = (v: unknown) => String(JSON.stringify(v)).slice(0, 700);

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();
const db = mongoose.connection.db!;

const ORG = new Types.ObjectId(), BANK = new Types.ObjectId(), RUN = new Types.ObjectId();
await db.collection("organizations").insertOne({ _id: ORG, name: "Delta HQ", baseCurrency: "AED" });
await db.collection("bankaccounts").insertOne({
  _id: BANK, organizationId: ORG, accountName: "Delta Bank", accountType: "bank", currency: "AED",
  openingBalanceMinor: 1_000_000_00, currentBalanceMinor: 0, isActive: true,
} as any);

const day = (d: string) => new Date(`${d}T00:00:00.000Z`);
const tx = (amountMinor: number, date: string, description: string, o: Record<string, any> = {}) => ({
  _id: new Types.ObjectId(), organizationId: ORG, accountId: BANK, accountName: "Delta Bank", currency: "AED", date: day(date),
  description, reference: "", amountMinor, type: amountMinor < 0 ? "debit" : "credit", runningBalanceMinor: 0, source: "manual", status: "matched",
  createdAt: new Date(), ...o,
});
// The payroll payments' own lines.
const T1 = tx(-3_500_00, "2026-11-02", "Payroll PAY-202610-002 · 2026-10 · 1 people", { matches: [{ type: "payroll", referenceId: String(RUN), referenceNumber: "PAY-202610-002" }] });
const T2 = tx(-9_776_00, "2026-11-02", "Payroll PAY-202610-002 · 2026-10 · 3 people", { matches: [{ type: "payroll", referenceId: String(RUN), referenceNumber: "PAY-202610-002" }] });
const T3 = tx(-24_673_00, "2026-11-02", "Payroll PAY-202610-002 · 2026-10 · 7 people");
const R3 = tx(24_673_00, "2026-11-03", "Reversal of PAY-202610-002-P1");
const T4 = tx(-1_000_00, "2026-11-02", "Payroll PAY-202610-002 · 2026-10 · 1 people");
const T5 = tx(-2_000_00, "2026-11-02", "Payroll PAY-202610-002 · 2026-10 · 1 people");

const E = (n: string, o: Record<string, any>) => ({
  _id: new Types.ObjectId(), organizationId: ORG, expenseNumber: n, category: "payroll_benefits", categoryName: "Payroll & Employee Benefits",
  description: "Payroll PAY-202610-002", expenseDate: day("2026-11-02"), amountMinor: 0, totalMinor: 0, currency: "AED", status: "approved",
  paymentMethod: "bank_transfer", paymentAccount: "Delta Bank", submittedById: new Types.ObjectId(), submittedByName: "Accounts",
  bankAccountId: null, bankTransactionId: null, ...o,
});
// The expenses' own lines — what marking them paid in Expenses made.
const D1 = tx(-3_500_00, "2026-11-02", "EXP-00273 · Payroll PAY-202610-002 · 2026-10 · 1 people");
const D3 = tx(-24_673_00, "2026-11-02", "EXP-00270 · Payroll PAY-202610-002 · 2026-10 · 7 people");
const D4 = tx(-1_000_00, "2026-11-02", "EXP-00280 · Payroll", { isReconciled: true });
const E1 = E("EXP-00273", { totalMinor: 3_500_00, amountMinor: 3_500_00, paidOn: day("2026-11-02"), bankAccountId: BANK, bankTransactionId: D1._id });
const E2 = E("EXP-00292", { totalMinor: 9_776_00, amountMinor: 9_776_00 });
const E3 = E("EXP-00270", { totalMinor: 24_673_00, amountMinor: 24_673_00, status: "voided", paidOn: day("2026-11-02"), bankAccountId: BANK, bankTransactionId: D3._id });
const E4 = E("EXP-00280", { totalMinor: 1_000_00, amountMinor: 1_000_00, paidOn: day("2026-11-02"), bankAccountId: BANK, bankTransactionId: D4._id, statementDate: day("2026-11-03") });
const E5 = E("EXP-00281", { totalMinor: 2_000_00, amountMinor: 2_000_00, paidOn: day("2026-11-02"), bankAccountId: BANK, bankTransactionId: T5._id, source: { kind: "payroll", key: `payroll:${RUN}:PAY-202610-002-P5`, round: 0 } });
for (const [d, e] of [[D1, E1], [D3, E3], [D4, E4]] as const) (d as any).matches = [{ type: "expense", referenceId: String(e._id), referenceNumber: e.expenseNumber }];

await db.collection("banktransactions").insertMany([T1, T2, T3, R3, T4, T5, D1, D3, D4] as any[]);
await db.collection("expenses").insertMany([E1, E2, E3, E4, E5] as any[]);
const pay = (n: number, t: any, e: any, amountMinor: number, o: Record<string, any> = {}) => ({
  paymentId: `PAY-202610-002-P${n}`, method: "bank_transfer", paidOn: day("2026-11-02"), reference: "", bankAccountId: BANK, bankAccountName: "Delta Bank",
  bankTransactionId: t._id, currency: "AED", amountMinor, allocations: [], expenseId: e._id, ...o,
});
await db.collection("payrollruns").insertOne({
  _id: RUN, organizationId: ORG, runNumber: "PAY-202610-002", period: "2026-10", status: "partially_paid", currency: "AED", lines: [], adjustments: [],
  payments: [
    pay(2, T1, E1, 3_500_00), pay(3, T2, E2, 9_776_00),
    pay(1, T3, E3, 24_673_00, { reversedAt: day("2026-11-03"), reversalTransactionId: R3._id }),
    pay(4, T4, E4, 1_000_00), pay(5, T5, E5, 2_000_00),
  ],
} as any);
await recalculateRunningBalances(String(ORG), BANK);

const balance = async () => ((await db.collection("bankaccounts").findOne({ _id: BANK })) as any).currentBalanceMinor as number;
const lineIds = async () => (await db.collection("banktransactions").find({}).toArray()).map((t) => String(t._id)).sort().join();
const exp = async (e: any) => db.collection("expenses").findOne({ _id: e._id }) as Promise<any>;
const plain = ({ updatedAt: _u, runningBalanceMinor: _r, ...d }: any) => d;
const snap = async () => JSON.stringify((await db.collection("banktransactions").find({}).sort({ _id: 1 }).toArray()).map(plain))
  + JSON.stringify((await db.collection("expenses").find({}).sort({ _id: 1 }).toArray()).map(plain)) + (await balance());

try {
  const opening = 1_000_000_00;
  const doubled = opening - 3_500_00 - 9_776_00 - 24_673_00 + 24_673_00 - 1_000_00 - 2_000_00 - 3_500_00 - 24_673_00 - 1_000_00;
  step("0. As the bug left it");
  check("the account down by the payroll lines and by the expenses' own lines too", (await balance()) === doubled, String(await balance()));
  const before = await snap();

  step("1. The dry run");
  let r = await fixPayrollExpenseLines({ write: false });
  const of = (p: number) => r.rows.find((x) => x.payment === `PAY-202610-002-P${p}`);
  check("the one marked paid: its own line comes out, linked to the payment's line", of(2)?.outcome === "would fix" && /takes out its own line in Delta Bank \(AED 3,500\.00/.test(of(2)!.detail) && /linked/.test(of(2)!.detail), show(of(2)));
  check("the one never marked paid: linked and paid, nothing to take out", of(3)?.outcome === "would fix" && !/takes out/.test(of(3)!.detail) && /paid 2026-11-02/.test(of(3)!.detail), show(of(3)));
  check("the reversed one's voided expense: its own line comes out too", of(1)?.outcome === "would fix" && /takes out its own line/.test(of(1)!.detail), show(of(1)));
  check("the one whose own line was reconciled: left, and why", of(4)?.outcome === "left" && /reconciled/.test(of(4)!.detail), show(of(4)));
  check("the one posted the new way: not listed", !of(5) && r.rows.length === 4, show(r.rows.map((x) => x.payment)));
  check("…nothing written", (await snap()) === before);
  let refused = ""; try { await fixPayrollExpenseLines({ write: true, expect: 2 }); } catch (e) { refused = (e as Error).message; }
  check("--expect with the wrong count: refused, nothing written", /--expect 2, but 3/.test(refused) && (await snap()) === before, refused);

  step("2. Written");
  const undoFile = join(mkdtempSync(join(tmpdir(), "payroll-lines-")), "undo.json");
  r = await fixPayrollExpenseLines({ write: true, expect: 3, undoFile });
  check("3 fixed, 1 left", r.rows.filter((x) => x.outcome === "fixed").length === 3 && r.rows.filter((x) => x.outcome === "left").length === 1, show(r.rows));
  const ids = await lineIds();
  check("the two lines the expenses made are gone; the payroll lines, the reversal and the reconciled one stay",
    !ids.includes(String(D1._id)) && !ids.includes(String(D3._id)) && [T1, T2, T3, R3, T4, T5, D4].every((t) => ids.includes(String(t._id))), ids);
  check("the account's balance: the money out once", (await balance()) === doubled + 3_500_00 + 24_673_00, String(await balance()));
  const last = (await db.collection("banktransactions").find({ accountId: BANK }).sort({ date: -1, createdAt: -1 }).limit(1).toArray())[0] as any;
  check("…and its running balance agrees", last.runningBalanceMinor === (await balance()), `${last.runningBalanceMinor} vs ${await balance()}`);
  const e1 = await exp(E1), e2 = await exp(E2), e3 = await exp(E3);
  check("EXP-00273: linked to its payment's line, paid, from payroll", String(e1.bankTransactionId) === String(T1._id) && e1.source?.kind === "payroll" && !!e1.paidOn, show(e1));
  check("EXP-00292: paid on the payment's day, in its account, linked to its line",
    String(e2.bankTransactionId) === String(T2._id) && String(e2.bankAccountId) === String(BANK) && new Date(e2.paidOn).toISOString().startsWith("2026-11-02"), show(e2));
  check("the reversed one's expense stays voided, linked to its payment's line", e3.status === "voided" && String(e3.bankTransactionId) === String(T3._id), show(e3));
  check("the reconciled one untouched", String((await exp(E4)).bankTransactionId) === String(D4._id));
  r = await fixPayrollExpenseLines({ write: false });
  check("run again: only the reconciled one is left", r.rows.length === 1 && r.rows[0]?.outcome === "left", show(r.rows));

  step("3. Undone");
  const u = await undoPayrollExpenseLines(undoFile);
  check("the 2 lines and 3 expenses back as they were, the balance too", u.lines === 2 && u.expenses === 3 && (await snap()) === before, show(u));
} finally {
  await mongoose.connection.db!.dropDatabase();
  await mongoose.disconnect();
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
