/**
 * Bulk delete in Banking (the user, 2026-11-11: "Select and delete option (bulk) action required in Bank section") —
 * finance's services in this process, on a scratch database:
 *
 *   1. Typed and imported lines ticked together: deleted, the balance worked out once and right.
 *   2. Lines that can't go stay, each saying why: reconciled (a bank account), matched to a record, a transfer side;
 *      a petty cash tin's reconciled line still goes; another account's or organization's line is never touched.
 *   3. A line made by its record (an expense paid from the account) can't be unmatched any more — it used to be, and
 *      then deleted while the expense still pointed at it. A line linked by hand still unmatches.
 *
 * Run through scripts/bank-bulk-delete-e2e.sh. Scratch databases only.
 */
import mongoose, { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}

const { Organization } = await import("../modules/organization/organization.model");
const { User } = await import("../modules/user/user.model");
const { BankAccount } = await import("../modules/banking/bank-account.model");
const { BankTransaction } = await import("../modules/banking/bank-transaction.model");
const banking = await import("../modules/banking/banking.service");
const { createTransfer } = await import("../modules/banking/transfer.service");
const ex = await import("../modules/expense/expense.service");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const j = (v: unknown) => JSON.stringify(v).slice(0, 500);
const refusal = async (p: Promise<unknown>) => p.then(() => "", (e: Error) => e.message);

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();

const org = await Organization.create({ name: "Delta HQ E2E", baseCurrency: "AED", lateEntryDays: 0 });
const other = await Organization.create({ name: "Other E2E", baseCurrency: "AED", lateEntryDays: 0 });
const ORG = String(org._id);
const asha = await User.create({ name: "Asha Accountant", email: "asha@e2e-bulk.test", passwordHash: "x", status: "active", memberships: [{ organizationId: org._id, roleId: new Types.ObjectId(), status: "active" }] });
const ASHA = String(asha._id);
const acct = (accountName: string, accountType = "current", orgId = ORG) =>
  banking.createBankAccount(orgId, { accountName, currency: "AED", accountType, openingBalanceMinor: 1_000_000, openingDate: "2026-01-01" } as never);
const bank = await acct("Delta Bank", "savings");
const bank2 = await acct("Delta Card");
const petty = await acct("Delta Petty", "petty_cash");
const theirs = await acct("Someone Else's", "current", String(other._id));
const balanceOf = async (id: string) => (await BankAccount.findById(id).lean<any>())?.currentBalanceMinor ?? 0;
const line = (accountId: string, amountMinor: number, description: string, date = "2026-10-05", orgId = ORG) =>
  banking.addTransaction(orgId, accountId, { date, description, reference: "", amountMinor, notes: "" } as never);

/* ── 1 ── */
step("1. Ticked together: deleted, the balance worked out once");
const a = await line(bank.id, 50_000, "Customer deposit");
const b = await line(bank.id, -20_000, "Bank charge");
const c = await line(bank.id, -5_000, "Fuel");
const imported = await banking.bulkImportTransactions(ORG, bank.id, { transactions: [
  { date: "2026-10-06", description: "Statement line A", amountMinor: -1_000, reference: "", notes: "" },
  { date: "2026-10-07", description: "Statement line B", amountMinor: 2_500, reference: "", notes: "" },
], onDuplicate: "skip" } as never);
const imp = await BankTransaction.find({ accountId: new Types.ObjectId(bank.id), source: "import" }).lean<any[]>();
check("set up: 3 typed + 2 imported lines", imp.length === 2 && (await balanceOf(bank.id)) === 1_000_000 + 50_000 - 20_000 - 5_000 - 1_000 + 2_500, j({ imported, bal: await balanceOf(bank.id) }));
let r = await banking.bulkDeleteTransactions(ORG, bank.id, [b.id, c.id, String(imp[0]._id)]);
check("three deleted, none left behind", r.deleted === 3 && r.skipped.length === 0, j(r));
check("…gone from the account", (await BankTransaction.countDocuments({ _id: { $in: [b.id, c.id, imp[0]._id] } })) === 0);
check("…the balance is what's left", (await balanceOf(bank.id)) === 1_000_000 + 50_000 + 2_500, String(await balanceOf(bank.id)));
const rest = await BankTransaction.find({ accountId: new Types.ObjectId(bank.id) }).sort({ date: 1, createdAt: 1 }).lean<any[]>();
check("…each running balance follows on", rest.length === 2 && rest[0].runningBalanceMinor === 1_050_000 && rest[1].runningBalanceMinor === 1_052_500, j(rest.map((x) => x.runningBalanceMinor)));

/* ── 2 ── */
step("2. What can't go stays, saying why");
const recon = await line(bank.id, -7_000, "Reconciled line");
await BankTransaction.updateOne({ _id: recon.id }, { $set: { isReconciled: true } });
const matched = await line(bank.id, -3_000, "Linked by hand");
await banking.matchTransaction(ORG, matched.id, { type: "invoice", referenceId: new Types.ObjectId().toString(), referenceNumber: "INV-00009", amountMinor: 3_000 } as never);
const tr = await createTransfer(ORG, { fromAccountId: bank.id, toAccountId: bank2.id, date: "2026-10-08", amountMinor: 10_000, reference: "", notes: "" } as never);
const trLine = await BankTransaction.findOne({ accountId: new Types.ObjectId(bank.id), "transfer.id": { $exists: true } }).lean<any>();
const pettyRecon = await line(petty.id, -1_500, "Tin line, counted");
await BankTransaction.updateOne({ _id: pettyRecon.id }, { $set: { isReconciled: true } });
const foreign = await line(theirs.id, -9_000, "Their line", "2026-10-05", String(other._id));
const other2 = await line(bank2.id, -4_000, "Card line");
const plain = await line(bank.id, -2_000, "Typo line");
const before = await balanceOf(bank.id);
r = await banking.bulkDeleteTransactions(ORG, bank.id, [recon.id, matched.id, String(trLine?._id), plain.id, foreign.id, other2.id, "not-an-id"]);
const why = (id: string) => r.skipped.find((x) => x.id === id)?.reason ?? "";
check("only the plain line deleted", r.deleted === 1 && !(await BankTransaction.exists({ _id: plain.id })), j(r));
check("reconciled: stays, says so", /reconciled/.test(why(recon.id)), why(recon.id));
check("matched to a record: stays, says so", /matched to invoice INV-00009/.test(why(matched.id)), why(matched.id));
check("a transfer side: stays, says so", /transfer/.test(why(String(trLine?._id))), why(String(trLine?._id)) || j(tr));
check("another organization's line: untouched", !!(await BankTransaction.exists({ _id: foreign.id })) && /not found/i.test(why(foreign.id)), why(foreign.id));
check("another account's line: untouched", !!(await BankTransaction.exists({ _id: other2.id })) && /not found/i.test(why(other2.id)), why(other2.id));
check("…each skipped one named with its date and amount", r.skipped.find((x) => x.id === recon.id)?.date === "2026-10-05" && r.skipped.find((x) => x.id === recon.id)?.amountMinor === -7_000, j(r.skipped));
check("the balance: only the plain line's money back", (await balanceOf(bank.id)) === before + 2_000, `${before} → ${await balanceOf(bank.id)}`);
r = await banking.bulkDeleteTransactions(ORG, petty.id, [pettyRecon.id]);
check("a petty cash tin's counted line still goes", r.deleted === 1 && (await balanceOf(petty.id)) === 1_000_000, j(r));

/* ── 3 ── */
step("3. A line made by its record can't be unmatched");
const e = await ex.createExpense(ORG, ASHA, {
  category: "office_supplies", subcategory: "stationery", description: "Printer ink", expenseDate: "2026-10-10", amountMinor: 20_000, currency: "AED",
  categoryOther: "", taxPct: 0, taxInclusive: false, paymentAccount: "", reference: "", requiresApproval: false, isRecurring: false,
  paymentMethod: "bank_transfer", bankAccountId: bank.id, paidOn: "2026-10-10",
} as never);
const eLine = await BankTransaction.findOne({ "matches.referenceId": e.id }).lean<any>();
check("set up: the paid expense has its line", !!eLine && eLine.accountId.toString() === bank.id, j({ e, eLine }));
check("unmatching it: refused, pointing at the expense", /comes from expense/.test(await refusal(banking.unmatchTransaction(ORG, String(eLine._id)))));
r = await banking.bulkDeleteTransactions(ORG, bank.id, [String(eLine._id)]);
check("…and it can't be bulk-deleted either", r.deleted === 0 && /matched to expense/.test(r.skipped[0]?.reason ?? ""), j(r));
const un = await banking.unmatchTransaction(ORG, matched.id);
check("a line linked by hand still unmatches", un.status === "unmatched" && un.matches.length === 0, j(un));
r = await banking.bulkDeleteTransactions(ORG, bank.id, [matched.id]);
check("…and then deletes", r.deleted === 1);

console.log(`\n${checks - failures}/${checks} passed`);
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
