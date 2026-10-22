/**
 * An expense paid as it is entered (the user, 2026-10-22: "when entering the expense on the bank it needs to reduce
 * the amount in the bank") — createExpense with paidOn against a scratch database:
 *   - paid now from an account: saved paid, its money-out line in the account at once, the balance down by the total;
 *   - not paid now: unpaid, nothing in the account — until Mark as paid;
 *   - one that needs approval: the paid date is not taken; unpaid until approved and marked paid;
 *   - an account in another currency: paid, but its balance does not move (said on the expense);
 *   - dated late, waiting for a manager: paid, but out of the account until the manager approves;
 *   - an edit does not take a paid date (that is Mark as paid / unpaid).
 *
 * Run through scripts/expense-paid-now-e2e.sh (throwaway mongod, no .env anywhere).
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
const { LateEntryModel } = await import("../modules/late-entry/late-entry.model");
const { createBankAccount, getBankAccount } = await import("../modules/banking/banking.service");
const { updateOrganization } = await import("../modules/organization/organization.service") as any;
const ex = await import("../modules/expense/expense.service");
const late = await import("../modules/late-entry/late-entry.service");
const { createExpenseSchema, updateExpenseSchema, lateEntryCutoff } = await import("@delta/shared");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const j = (v: unknown) => String(JSON.stringify(v)).slice(0, 400);

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();

const org = await Organization.create({ name: "Delta HQ E2E", baseCurrency: "AED", lateEntryDays: 0 });
const ORG = String(org._id);
const role = await Role.create({ organizationId: org._id, key: "accountant", name: "Accountant", permissions: ["expense:approve"] });
const person = (name: string, extra: Record<string, unknown> = {}) => User.create({
  name, email: `${name.toLowerCase().replace(/\s/g, ".")}@e2e-paid.test`, passwordHash: "x", status: "active",
  memberships: [{ organizationId: org._id, roleId: role._id, status: "active", ...extra }],
});
const asha = await person("Asha Accountant"), mona = await person("Mona Manager", { isManager: true });
const ASHA = String(asha._id), MONA = String(mona._id);
const bank = await createBankAccount(ORG, { accountName: "Delta Bank", currency: "AED", accountType: "current", openingBalanceMinor: 1_000_000, openingDate: "2026-01-01" } as never);
const usd = await createBankAccount(ORG, { accountName: "USD Account", currency: "USD", accountType: "current", openingBalanceMinor: 0, openingDate: "2026-01-01" } as never);
const balance = async (id = bank.id) => (await getBankAccount(ORG, id)).currentBalanceMinor;
const lineFor = (id: string) => BankTransaction.findOne({ "matches.referenceId": id }).lean<any>();
const TODAY = lateEntryCutoff(1);
const expense = (over: Record<string, unknown>, reason?: string) => ex.createExpense(ORG, ASHA, createExpenseSchema.parse({
  category: "travel_transport", subcategory: "business_taxi", description: "Taxi", expenseDate: TODAY, amountMinor: 25_000, currency: "AED",
  paymentMethod: "bank_transfer", bankAccountId: bank.id, ...over,
}) as never, { userId: ASHA, reason });

/* ── 1 ── */
step("1. Paid now from its account");
let e = await expense({ paidOn: TODAY });
let line = await lineFor(e.id);
check("saved paid, on the day given", e.paymentStatus === "paid" && e.paidOn === TODAY, j({ s: e.paymentStatus, p: e.paidOn }));
check("its money-out line is in Delta Bank at once, for the total", !!line && String(line.accountId) === bank.id && line.type === "debit" && Math.abs(line.amountMinor) === 25_000, j(line));
check("the balance went down by it", (await balance()) === 1_000_000 - 25_000, String(await balance()));
const e2 = await expense({ paidOn: "2026-10-01", expenseDate: TODAY });
check("a paid date of its own: the line on that day", (await lineFor(e2.id))?.date?.toISOString().slice(0, 10) === "2026-10-01" && (await balance()) === 1_000_000 - 50_000);

/* ── 2 ── */
step("2. Not paid now");
e = await expense({});
check("unpaid, nothing in the account", e.paymentStatus !== "paid" && !(await lineFor(e.id)) && (await balance()) === 950_000, j(e.paymentStatus));
e = await ex.markExpensePaid(ORG, e.id, { paidOn: TODAY } as never);
check("…until marked paid: then out of the account", !!(await lineFor(e.id)) && (await balance()) === 925_000, String(await balance()));

/* ── 3 ── */
step("3. One that needs approval");
e = await expense({ paidOn: TODAY, requiresApproval: true });
check("the paid date is not taken: unpaid, nothing in the account", e.status === "submitted" && e.paymentStatus !== "paid" && !(await lineFor(e.id)) && (await balance()) === 925_000, j({ st: e.status, p: e.paymentStatus }));
await ex.approveExpense(ORG, e.id, MONA, "Mona Manager");
e = await ex.markExpensePaid(ORG, e.id, { paidOn: TODAY } as never);
check("approved and marked paid: then out of the account", !!(await lineFor(e.id)) && (await balance()) === 900_000);

/* ── 4 ── */
step("4. An account in another currency");
e = await expense({ paidOn: TODAY, bankAccountId: usd.id });
check("paid, but the USD account does not move — and the expense says why", e.paymentStatus === "paid" && !(await lineFor(e.id)) && (await balance(usd.id)) === 0 && /USD/.test((e as any).bankNote ?? ""), j({ p: e.paymentStatus, note: (e as any).bankNote }));

/* ── 5 ── */
step("5. Dated late, waiting for a manager");
await updateOrganization(ORG, { lateEntryDays: 1 });
const YESTERDAY = lateEntryCutoff(2);
e = await expense({ expenseDate: YESTERDAY, paidOn: YESTERDAY }, "Receipt came today");
check("paid, but out of the account while a manager has to approve it", e.paymentStatus === "paid" && e.lateEntry?.state === "pending" && !(await lineFor(e.id)) && (await balance()) === 900_000, j(e.lateEntry));
const entry = await LateEntryModel.findOne({ refId: new Types.ObjectId(e.id) }).lean<any>();
await late.decideLateEntry(ORG, MONA, String(entry._id), "approved", "");
check("approved: then out of the account", !!(await lineFor(e.id)) && (await balance()) === 875_000, String(await balance()));
await updateOrganization(ORG, { lateEntryDays: 0 });

/* ── 6 ── */
step("6. An edit does not take a paid date");
const parsed = updateExpenseSchema.parse({ description: "Taxi again", paidOn: TODAY } as never) as Record<string, unknown>;
check("the edit's input has no paid date", !("paidOn" in parsed), j(parsed));

console.log(`\n${checks - failures}/${checks} passed`);
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
