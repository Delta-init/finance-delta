/**
 * Transfers between the organization's own accounts (the user, 2026-10-22: "a new item in petty cash, an internal
 * transfer") — transfer.service against a scratch database:
 *   - a tin topped up from the bank: two linked lines, out of one and into the other; both balances move, nothing else;
 *   - corrected or deleted as a transfer, both sides together — a single line of it is refused on its own;
 *   - between currencies: both figures, and refused without what arrived; same account / closed account refused;
 *   - dated back: one request to a manager, both lines with it; rejected, both go; approved, both stand;
 *   - a line reconciled to a bank statement holds the transfer; the Daily Report does not count it.
 *
 * Run through scripts/transfer-e2e.sh (throwaway mongod, no .env anywhere).
 */
import mongoose, { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}

const { Organization } = await import("../modules/organization/organization.model");
const { User } = await import("../modules/user/user.model");
const { Role } = await import("../modules/role/role.model");
const { BankTransaction } = await import("../modules/banking/bank-transaction.model");
const { BankAccount } = await import("../modules/banking/bank-account.model");
const { LateEntryModel } = await import("../modules/late-entry/late-entry.model");
const banking = await import("../modules/banking/banking.service");
const tr = await import("../modules/banking/transfer.service");
const late = await import("../modules/late-entry/late-entry.service");
const reports = await import("../modules/reports/reports.service");
const { updateOrganization } = await import("../modules/organization/organization.service") as any;
const { createTransferSchema, updateTransferSchema, lateEntryCutoff } = await import("@delta/shared");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const j = (v: unknown) => String(JSON.stringify(v)).slice(0, 400);
const refusal = async (p: Promise<unknown>) => p.then(() => "", (e: Error) => e.message);

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();

const org = await Organization.create({ name: "Delta HQ E2E", baseCurrency: "AED", lateEntryDays: 0 });
const ORG = String(org._id);
const role = await Role.create({ organizationId: org._id, key: "accountant", name: "Accountant", permissions: [] });
const asha = await User.create({ name: "Asha Accountant", email: "asha@e2e-tr.test", passwordHash: "x", status: "active", memberships: [{ organizationId: org._id, roleId: role._id, status: "active" }] });
const mona = await User.create({ name: "Mona Manager", email: "mona@e2e-tr.test", passwordHash: "x", status: "active", memberships: [{ organizationId: org._id, roleId: role._id, status: "active", isManager: true }] });
const ASHA = String(asha._id), MONA = String(mona._id);
const acct = (accountName: string, accountType: string, currency: string, openingBalanceMinor: number) =>
  banking.createBankAccount(ORG, { accountName, currency, accountType, openingBalanceMinor, openingDate: "2026-01-01" } as never);
const bank = await acct("Delta Bank", "current", "AED", 1_000_000);
const tin = await acct("Petty Cash", "petty_cash", "AED", 50_000);
const inr = await acct("Bangalore Bank", "current", "INR", 0);
const shut = await acct("Old Account", "current", "AED", 0);
await BankAccount.updateOne({ _id: shut.id }, { $set: { isActive: false } });
const bal = async (id: string) => (await banking.getBankAccount(ORG, id)).currentBalanceMinor;
const TODAY = lateEntryCutoff(1);
const make = (over: Record<string, unknown>, reason?: string) =>
  tr.createTransfer(ORG, createTransferSchema.parse({ fromAccountId: bank.id, toAccountId: tin.id, date: TODAY, amountMinor: 200_000, reference: "TOPUP-1", ...over }) as never, { userId: ASHA, reason });

/* ── 1 ── */
step("1. The tin topped up from the bank");
const t = await make({});
check("two lines: out of Delta Bank, into Petty Cash, the same day and reference",
  t.out.accountId === bank.id && t.out.amountMinor === -200_000 && t.out.type === "debit" && t.in.accountId === tin.id && t.in.amountMinor === 200_000
  && t.out.date === TODAY && t.in.date === TODAY && t.out.reference === "TOPUP-1" && t.in.reference === "TOPUP-1", j(t));
check("each says where it went or came from, and names the other", t.out.description === "Transfer to Petty Cash" && t.in.description === "Transfer from Delta Bank"
  && t.out.transfer?.direction === "out" && t.in.transfer?.direction === "in" && t.out.transfer?.otherTransactionId === t.in.id && t.in.transfer?.otherAccountId === bank.id, j([t.out.transfer, t.in.transfer]));
check("Delta Bank 10,000 → 8,000; Petty Cash 500 → 2,500", (await bal(bank.id)) === 800_000 && (await bal(tin.id)) === 250_000);

/* ── 2 ── */
step("2. Changed as a transfer, never one side alone");
check("a line of it edited alone: refused", /one side of a transfer with Petty Cash/.test(await refusal(banking.updateTransaction(ORG, bank.id, t.out.id, { amountMinor: -1 } as never))));
check("…or deleted alone: refused", /one side of a transfer/.test(await refusal(banking.deleteTransaction(ORG, tin.id, t.in.id))));
const u = await tr.updateTransfer(ORG, t.id, updateTransferSchema.parse({ amountMinor: 150_000, date: lateEntryCutoff(0) }) as never, { userId: ASHA });
check("amount corrected: both sides follow", u.out.amountMinor === -150_000 && u.in.amountMinor === 150_000 && (await bal(bank.id)) === 850_000 && (await bal(tin.id)) === 200_000, j([u.out.amountMinor, u.in.amountMinor]));
await tr.deleteTransfer(ORG, t.id);
check("deleted: both lines go, both balances back", (await BankTransaction.countDocuments({ "transfer.id": new Types.ObjectId(t.id) })) === 0 && (await bal(bank.id)) === 1_000_000 && (await bal(tin.id)) === 50_000);

/* ── 3 ── */
step("3. Between currencies; what is refused");
check("AED → INR without what arrived: refused, saying so", /say how much arrived in INR/.test(await refusal(make({ toAccountId: inr.id }))));
const x = await make({ toAccountId: inr.id, amountMinor: 100_000, receivedMinor: 2_300_000 });
check("with it: AED 1,000 out, INR 23,000 in, each line naming the other's figure",
  (await bal(bank.id)) === 900_000 && (await bal(inr.id)) === 2_300_000 && x.out.transfer?.otherAmountMinor === 2_300_000 && x.in.transfer?.otherAmountMinor === 100_000 && x.in.transfer?.otherCurrency === "AED");
const x2 = await tr.updateTransfer(ORG, x.id, { amountMinor: 120_000, receivedMinor: 2_760_000 } as never, { userId: ASHA });
check("corrected with both figures", x2.out.amountMinor === -120_000 && x2.in.amountMinor === 2_760_000 && (await bal(inr.id)) === 2_760_000);
await tr.deleteTransfer(ORG, x.id);
check("the same account on both sides: refused", /two different accounts/.test(await refusal(make({ toAccountId: bank.id }))));
check("a closed account: refused", /Old Account is closed/.test(await refusal(make({ toAccountId: shut.id }))));

/* ── 4 ── */
step("4. Dated back: one request, both lines with it");
await updateOrganization(ORG, { lateEntryDays: 1 });
const YESTERDAY = lateEntryCutoff(2);
check("yesterday with no reason: refused", /give the reason/.test(await refusal(make({ date: YESTERDAY }))));
const l = await make({ date: YESTERDAY, amountMinor: 30_000 }, "Slip found today");
const entries = await LateEntryModel.find({ refId: { $in: [new Types.ObjectId(l.out.id), new Types.ObjectId(l.in.id)] } }).lean<any[]>();
check("both lines waiting, one request — on the out line", l.out.lateEntry?.state === "pending" && l.in.lateEntry?.state === "pending" && entries.length === 1 && String(entries[0].refId) === l.out.id, j(entries.map((e) => e.title)));
await late.decideLateEntry(ORG, MONA, String(entries[0]._id), "rejected", "Not ours");
check("rejected: both lines go, both balances back", (await BankTransaction.countDocuments({ "transfer.id": new Types.ObjectId(l.id) })) === 0 && (await bal(bank.id)) === 1_000_000 && (await bal(tin.id)) === 50_000);
const l2 = await make({ date: YESTERDAY, amountMinor: 40_000 }, "Late slip");
const e2 = await LateEntryModel.findOne({ refId: new Types.ObjectId(l2.out.id) }).lean<any>();
await late.decideLateEntry(ORG, MONA, String(e2._id), "approved", "");
const both = await BankTransaction.find({ "transfer.id": new Types.ObjectId(l2.id) }).lean<any[]>();
check("approved: both stand, both say so", both.length === 2 && both.every((b) => b.lateEntry?.state === "approved") && (await bal(tin.id)) === 90_000);
await updateOrganization(ORG, { lateEntryDays: 0 });

/* ── 5 ── */
step("5. Held by a statement; out of the reports");
await BankTransaction.updateOne({ _id: l2.out.id }, { $set: { isReconciled: true } });
check("its bank line reconciled to a statement: the transfer cannot be changed", /reconciled/.test(await refusal(tr.updateTransfer(ORG, l2.id, { amountMinor: 1 } as never, { userId: ASHA }))) && /reconciled/.test(await refusal(tr.deleteTransfer(ORG, l2.id))));
const daily = await reports.getDailyReport(ORG, YESTERDAY, TODAY);
check("the Daily Report counts no transfer as income or expense", daily.totals.incomeMinor === 0 && daily.totals.expenseMinor === 0, j(daily.totals));

console.log(`\n${checks - failures}/${checks} passed`);
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
