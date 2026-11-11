/**
 * Payments into Banking once, and bank lines matched to expenses only (the user, 2026-11-11: "If we create or mapped
 * record payment that comes in Bank"; "Bank and expenses required matching only") — finance's services in this
 * process, on a scratch database:
 *
 *   1. A typed payment with "Not in a bank account" is refused while the organization has an account; not given, the
 *      method's account is used as before; an organization with no account at all isn't stopped.
 *   2. A statement line that is a payment already in the books (same amount within 3 days of the line a record made)
 *      is flagged on the import preview and left out — not counted twice; its bank reference goes on the book line;
 *      "import anyway" brings it in marked duplicate; other lines import as before.
 *   3. Match to an expense: only expenses not in Banking, same currency, same amount within 3 days (wider: any amount,
 *      30 days); matched, the expense is paid from the account on the line's day through that very line — nothing
 *      added, the bank's wording kept; it can't be unmatched (change the expense); the expense marked unpaid lets the
 *      line go, still there; money in, a matched line or different amounts are refused.
 *
 * Run through scripts/bank-match-e2e.sh. Scratch databases only.
 */
import mongoose, { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}

const { Organization } = await import("../modules/organization/organization.model");
const { User } = await import("../modules/user/user.model");
const { Expense } = await import("../modules/expense/expense.model");
const { BankAccount } = await import("../modules/banking/bank-account.model");
const { BankTransaction } = await import("../modules/banking/bank-transaction.model");
const banking = await import("../modules/banking/banking.service");
const { assertAccountChosen } = await import("../modules/banking/account-chosen");
const { expenseCandidates, matchLineToExpense } = await import("../modules/banking/match-expense");
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
const bare = await Organization.create({ name: "No Accounts E2E", baseCurrency: "AED", lateEntryDays: 0 });
const ORG = String(org._id);
const asha = await User.create({ name: "Asha Accountant", email: "asha@e2e-match.test", passwordHash: "x", status: "active", memberships: [{ organizationId: org._id, roleId: new Types.ObjectId(), status: "active" }] });
const ASHA = String(asha._id);
const bank = await banking.createBankAccount(ORG, { accountName: "Delta Bank", currency: "AED", accountType: "current", openingBalanceMinor: 1_000_000, openingDate: "2026-01-01" } as never);
const balanceOf = async (id: string) => (await BankAccount.findById(id).lean<any>())?.currentBalanceMinor ?? 0;
const expense = (over: Record<string, unknown> = {}) => ex.createExpense(ORG, ASHA, {
  category: "office_supplies", subcategory: "stationery", description: "Printer ink", expenseDate: "2026-10-10", amountMinor: 20_000, currency: "AED",
  categoryOther: "", taxPct: 0, taxInclusive: false, paymentAccount: "", reference: "", requiresApproval: false, isRecurring: false,
  paymentMethod: "bank_transfer", bankAccountId: "", ...over,
} as never);

/* ── 1 ── */
step("1. A typed payment goes into an account");
check("\"Not in a bank account\" while there is one: refused", /Choose the account/.test(await refusal(assertAccountChosen(ORG, ""))));
check("not given: the method's account, as before", (await refusal(assertAccountChosen(ORG, undefined))) === "");
check("an account chosen: fine", (await refusal(assertAccountChosen(ORG, bank.id))) === "");
check("an organization with no account at all: not stopped", (await refusal(assertAccountChosen(String(bare._id), ""))) === "");

/* ── 2 ── */
step("2. A statement line already in the books isn't counted twice");
const paid = await expense({ bankAccountId: bank.id, paidOn: "2026-10-10", amountMinor: 35_000, description: "Courier" });
const bookLine = await BankTransaction.findOne({ "matches.referenceId": paid.id }).lean<any>();
check("set up: the paid expense's line in Delta Bank", !!bookLine && bookLine.amountMinor === -35_000, j(bookLine));
const statement = [
  { date: "2026-10-11", description: "POS 4471 COURIER CO DUBAI", amountMinor: -35_000, reference: "", externalId: "FT-0001", notes: "" },
  { date: "2026-10-12", description: "Card fee", amountMinor: -1_500, reference: "", notes: "" },
];
const pv = await banking.previewImport(ORG, bank.id, { transactions: statement } as never);
check("preview: the courier line flagged as in the books, as the expense", pv.duplicates.includes(0) && pv.inBooks.some((b) => b.index === 0 && b.label === `expense ${paid.expenseNumber}`) && !pv.duplicates.includes(1), j(pv));
const before = await balanceOf(bank.id);
const imp = await banking.bulkImportTransactions(ORG, bank.id, { transactions: statement, onDuplicate: "skip" } as never);
check("import: the courier line left out, the fee brought in", imp.count === 1 && imp.skipped === 1 && imp.transactions[0]?.description === "Card fee", j(imp));
check("…the balance counts the courier once", (await balanceOf(bank.id)) === before - 1_500, `${before} → ${await balanceOf(bank.id)}`);
check("…the bank's reference put on the book line", (await BankTransaction.findById(bookLine._id).lean<any>())?.externalId === "FT-0001");
const again = await banking.previewImport(ORG, bank.id, { transactions: [statement[0]!] } as never);
check("the same statement again: known for sure now", again.duplicates.includes(0), j(again));
const paid2 = await expense({ bankAccountId: bank.id, paidOn: "2026-10-20", amountMinor: 8_000, description: "Taxi" });
const anyway = await banking.bulkImportTransactions(ORG, bank.id, { transactions: [{ date: "2026-10-21", description: "CAREEM", amountMinor: -8_000, reference: "", notes: "" }], onDuplicate: "import" } as never);
check("\"import anyway\": brought in, marked duplicate", anyway.count === 1 && anyway.transactions[0]?.status === "duplicate", j(anyway));
const far = await banking.previewImport(ORG, bank.id, { transactions: [{ date: "2026-10-25", description: "Taxi again", amountMinor: -8_000, reference: "", notes: "" }] } as never);
check("the same amount 5 days off: not taken as it", !far.duplicates.includes(0), j(far) + j(paid2.id));

/* ── 3 ── */
step("3. Match to an expense — only an expense");
const stmt = await banking.bulkImportTransactions(ORG, bank.id, { transactions: [
  { date: "2026-11-02", description: "ADCB TRANSFER STATIONERY LLC", amountMinor: -12_500, reference: "", notes: "" },
  { date: "2026-11-02", description: "Customer receipt", amountMinor: 40_000, reference: "", notes: "" },
], onDuplicate: "skip" } as never);
const out = stmt.transactions.find((t: any) => t.amountMinor === -12_500)!;
const inn = stmt.transactions.find((t: any) => t.amountMinor === 40_000)!;
const target = await expense({ amountMinor: 12_500, expenseDate: "2026-11-01", description: "Stationery" });
const otherAmount = await expense({ amountMinor: 12_000, expenseDate: "2026-11-02", description: "Paper" });
const tooFar = await expense({ amountMinor: 12_500, expenseDate: "2026-10-20", description: "Old stationery" });
const inBank = await expense({ amountMinor: 12_500, expenseDate: "2026-11-02", bankAccountId: bank.id, paidOn: "2026-11-02", description: "Already paid" });
let cand = await expenseCandidates(ORG, bank.id, out.id);
const ids = cand.candidates.map((c) => c.id);
check("offered: the same amount within 3 days", ids.includes(target.id), j(cand));
check("…not another amount, not 13 days off, not one in Banking already", !ids.includes(otherAmount.id) && !ids.includes(tooFar.id) && !ids.includes(inBank.id), j(ids));
cand = await expenseCandidates(ORG, bank.id, out.id, { wide: true });
check("wider: other amounts and dates too, the same amount first", cand.candidates[0]?.id === target.id && cand.candidates.some((c) => c.id === otherAmount.id && !c.sameAmount) && cand.candidates.some((c) => c.id === tooFar.id), j(cand.candidates.map((c) => c.expenseNumber)));
check("money in: refused", /Money in/.test(await refusal(expenseCandidates(ORG, bank.id, inn.id))));
check("different amounts: refused", /amounts have to agree/.test(await refusal(matchLineToExpense(ORG, bank.id, out.id, otherAmount.id))));
check("…and the line is free again after", !(await BankTransaction.findById(out.id).lean<any>())?.adopted);
const linesBefore = await BankTransaction.countDocuments({ accountId: new Types.ObjectId(bank.id) });
const bal = await balanceOf(bank.id);
const m = await matchLineToExpense(ORG, bank.id, out.id, target.id);
const e1 = await Expense.findById(target.id).lean<any>();
const l1 = await BankTransaction.findById(out.id).lean<any>();
check("matched: the expense paid from Delta Bank on the line's day, through that line", String(e1.bankTransactionId) === out.id && String(e1.bankAccountId) === bank.id
  && new Date(e1.paidOn).toISOString().slice(0, 10) === "2026-11-02" && m.expense.id === target.id, j({ e1, m }));
check("…the line matched to it, the bank's wording kept", l1.status === "matched" && l1.matches[0]?.referenceId === target.id && l1.description === "ADCB TRANSFER STATIONERY LLC", j(l1));
check("…nothing added, the balance as it was", (await BankTransaction.countDocuments({ accountId: new Types.ObjectId(bank.id) })) === linesBefore && (await balanceOf(bank.id)) === bal);
check("a matched line: refused again", /matched to expense/.test(await refusal(matchLineToExpense(ORG, bank.id, out.id, tooFar.id))));
check("it can't be unmatched — change the expense", /comes from expense/.test(await refusal(banking.unmatchTransaction(ORG, out.id))));
await ex.markExpenseUnpaid(ORG, target.id);
const l2 = await BankTransaction.findById(out.id).lean<any>();
check("the expense marked unpaid: the line let go, still there, unmatched", !!l2 && l2.status === "unmatched" && l2.matches.length === 0 && !l2.adopted && (await balanceOf(bank.id)) === bal, j(l2));
check("…and offered again", (await expenseCandidates(ORG, bank.id, out.id)).candidates.some((c) => c.id === target.id));
const typed = await banking.addTransaction(ORG, bank.id, { date: "2026-11-05", description: "Cash for parking", reference: "", amountMinor: -3_000, notes: "" } as never);
const park = await expense({ amountMinor: 3_000, expenseDate: "2026-11-05", description: "Parking" });
await matchLineToExpense(ORG, bank.id, typed.id, park.id);
await ex.voidExpense(ORG, park.id);
check("a typed line matched, then the expense voided: the line stays, unmatched", (await BankTransaction.findById(typed.id).lean<any>())?.status === "unmatched");

console.log(`\n${checks - failures}/${checks} passed`);
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
