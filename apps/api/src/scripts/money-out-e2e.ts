/**
 * Money out of the bank (the user, 2026-10-16: "if payment method is cash its bank will be petty … the bank will be a
 * drop down also and backfill current payments also including expense invoice and others") — finance's services in
 * this process, on a scratch database:
 *
 *   1. An expense: its method's account to start with (cash → petty cash), the one picked, or none; once paid, a
 *      matched debit there and the balance down by its total.
 *   2. It follows the expense: another amount or account — the line moves; unpaid, voided, deleted — it goes.
 *   3. An account in another currency: kept, out of the balance, saying why. Another organization's: refused.
 *   4. Reconciled against a bank statement: amount, account, date, unpaid, void and delete refused; a note still
 *      edits; a petty cash tin's line still moves.
 *   5. Salary advances / one-time payments (placeExpenseInBank): their method's account and line.
 *   6. A bill payment: its method's account or the one picked, a debit, follows edits, goes when deleted.
 *   7. The backfill: settings, invoice payments, expenses (typed "ADCB" → the named account, else the method's), bill
 *      payments; dry run writes nothing; a backup first; run again, nothing to do.
 *
 * Run through scripts/money-out-e2e.sh. Scratch databases only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import mongoose, { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}

const { Organization } = await import("../modules/organization/organization.model");
const { User } = await import("../modules/user/user.model");
const { Invoice } = await import("../modules/invoice/invoice.model");
const { Expense } = await import("../modules/expense/expense.model");
const { Bill } = await import("../modules/bill/bill.model");
const { Vendor } = await import("../modules/vendor/vendor.model");
const { BankAccount } = await import("../modules/banking/bank-account.model");
const { BankTransaction } = await import("../modules/banking/bank-transaction.model");
const { createBankAccount } = await import("../modules/banking/banking.service");
const { updateOrganization } = await import("../modules/organization/organization.service");
const ex = await import("../modules/expense/expense.service");
const bills = await import("../modules/bill/bill.service");
const inv = await import("../modules/invoice/invoice.service");
const { findOrCreateCustomer } = await import("../modules/customer/customer.service");
const { backfillBankAccounts } = await import("./bank-accounts-backfill");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const j = (v: unknown) => JSON.stringify(v).slice(0, 400);
const refusal = async (p: Promise<unknown>) => p.then(() => "", (e: Error) => e.message);
const ALL = { all: true } as const;

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();

const org = await Organization.create({ name: "Delta HQ E2E", baseCurrency: "AED" });
const other = await Organization.create({ name: "Other E2E", baseCurrency: "AED" });
const ORG = String(org._id);
const asha = await User.create({ name: "Asha Accountant", email: "asha@e2e-out.test", passwordHash: "x", status: "active", memberships: [{ organizationId: org._id, roleId: new Types.ObjectId(), status: "active" }] });
const ASHA = String(asha._id);
const acct = (accountName: string, currency: string, accountType = "current", orgId = ORG) =>
  createBankAccount(orgId, { accountName, currency, accountType, openingBalanceMinor: 1_000_000, openingDate: "2026-01-01" } as never);
const bank = await acct("Delta Bank", "AED", "savings");
const petty = await acct("Delta Petty", "AED", "petty_cash");
const yaroon = await acct("Yaroon", "INR");
const theirs = await acct("Someone Else's", "AED", "current", String(other._id));
const balanceOf = async (id: string) => (await BankAccount.findById(id).lean<any>())?.currentBalanceMinor ?? 0;
const linesOf = (id: string) => BankTransaction.find({ accountId: new Types.ObjectId(id) }).lean<any[]>();
const START = 1_000_000;

await updateOrganization(ORG, { paymentAccounts: { cash: petty.id, bank_transfer: bank.id, cheque: bank.id, card: bank.id, inr_bank_account: yaroon.id } });

const expense = (over: Record<string, unknown> = {}) => ex.createExpense(ORG, ASHA, {
  category: "office_supplies", subcategory: "stationery", description: "Printer ink", expenseDate: "2026-10-10", amountMinor: 20_000, currency: "AED",
  categoryOther: "", taxPct: 0, taxInclusive: false, paymentAccount: "", reference: "", requiresApproval: false, isRecurring: false,
  paymentMethod: "cash", ...over,
} as never);

/* ── 1 ── */
step("1. An expense: its method's account, and money out once paid");
let e = await expense();
check("cash → Delta Petty, named so on the expense", e.bankAccountId === petty.id && e.paymentAccount === "Delta Petty", j(e));
check("unpaid: no line yet", (await linesOf(petty.id)).length === 0 && (await balanceOf(petty.id)) === START);
e = await ex.markExpensePaid(ORG, e.id, { paidOn: "2026-10-11" } as never);
let lines = await linesOf(petty.id);
check("paid: one debit of AED 200 in Delta Petty, matched to the expense", lines.length === 1 && lines[0].amountMinor === -20_000 && lines[0].type === "debit"
  && lines[0].status === "matched" && lines[0].matches[0]?.type === "expense" && lines[0].matches[0]?.referenceId === e.id && lines[0].matches[0]?.amountMinor === 20_000, j(lines));
check("Delta Petty's balance down by AED 200", (await balanceOf(petty.id)) === START - 20_000, String(await balanceOf(petty.id)));
check("the expense says it is in the account", e.inBank === true && !e.bankNote, j(e));
const e2 = await expense({ paymentMethod: "bank_transfer", bankAccountId: petty.id, amountMinor: 5_000 });
check("one picked by hand is kept over the method's", e2.bankAccountId === petty.id);
const e3 = await expense({ paymentMethod: "bank_transfer", bankAccountId: "" });
check("\"\" — not in a bank account", !e3.bankAccountId);
const e4 = await expense({ paymentMethod: "online" });
check("a method with no account: none", !e4.bankAccountId);

/* ── 2 ── */
step("2. It follows the expense");
e = await ex.updateExpense(ORG, e.id, { amountMinor: 30_000 } as never, ALL);
lines = await linesOf(petty.id);
check("amount AED 300: the line follows, balance down by AED 300", lines.length === 1 && lines[0].amountMinor === -30_000 && (await balanceOf(petty.id)) === START - 30_000, j(lines));
e = await ex.updateExpense(ORG, e.id, { bankAccountId: bank.id } as never, ALL);
check("moved to Delta Bank: gone from petty, in the bank", (await linesOf(petty.id)).length === 0 && (await balanceOf(petty.id)) === START
  && (await balanceOf(bank.id)) === START - 30_000 && e.paymentAccount === "Delta Bank", String(await balanceOf(bank.id)));
e = await ex.updateExpense(ORG, e.id, { paymentMethod: "cash" } as never, ALL);
check("a change of method alone does not move an account already set", e.bankAccountId === bank.id);
e = await ex.markExpenseUnpaid(ORG, e.id);
check("unpaid: the line goes, balance back", (await linesOf(bank.id)).length === 0 && (await balanceOf(bank.id)) === START && !e.inBank);
e = await ex.markExpensePaid(ORG, e.id, { paidOn: "2026-10-12", bankAccountId: "" } as never);
check("paid from no account: no line anywhere", !e.bankAccountId && (await linesOf(bank.id)).length === 0 && (await linesOf(petty.id)).length === 0);
e = await ex.markExpensePaid(ORG, e.id, { paidOn: "2026-10-12", bankAccountId: petty.id } as never);
check("paid from Delta Petty: its line", (await balanceOf(petty.id)) === START - 30_000);
e = await ex.voidExpense(ORG, e.id);
check("voided: the line goes", (await linesOf(petty.id)).length === 0 && (await balanceOf(petty.id)) === START);
let d = await expense({ paymentMethod: "bank_transfer" });
d = await ex.markExpensePaid(ORG, d.id, { paidOn: "2026-10-13" } as never);
check("another, paid from Delta Bank", (await balanceOf(bank.id)) === START - 20_000);
await ex.deleteExpense(ORG, d.id);
check("deleted: its line goes with it", (await linesOf(bank.id)).length === 0 && (await balanceOf(bank.id)) === START);

/* ── 3 ── */
step("3. Another currency; another organization");
let f = await expense({ paymentMethod: "bank_transfer", bankAccountId: yaroon.id });
f = await ex.markExpensePaid(ORG, f.id, { paidOn: "2026-10-13" } as never);
check("an AED expense from Yaroon (INR): kept, no line, saying why", f.bankAccountId === yaroon.id && (await linesOf(yaroon.id)).length === 0 && /INR/.test(f.bankNote ?? ""), j(f));
check("another organization's account is refused", /not one of this organization's/.test(await refusal(expense({ bankAccountId: theirs.id }))));
check("…when marking paid too", /not one of this organization's/.test(await refusal(ex.markExpensePaid(ORG, f.id, { paidOn: "2026-10-13", bankAccountId: theirs.id } as never))));

/* ── 4 ── */
step("4. Reconciled against a bank statement");
let r = await expense({ paymentMethod: "bank_transfer" });
r = await ex.markExpensePaid(ORG, r.id, { paidOn: "2026-10-14" } as never);
await BankTransaction.updateMany({ accountId: new Types.ObjectId(bank.id) }, { $set: { isReconciled: true } });
check("its amount can't change", /reconciled/.test(await refusal(ex.updateExpense(ORG, r.id, { amountMinor: 1_000 } as never, ALL))));
check("nor its account", /reconciled/.test(await refusal(ex.updateExpense(ORG, r.id, { bankAccountId: petty.id } as never, ALL))));
check("nor unpaid", /reconciled/.test(await refusal(ex.markExpenseUnpaid(ORG, r.id))));
check("nor voided", /reconciled/.test(await refusal(ex.voidExpense(ORG, r.id))));
check("nor deleted", /reconciled/.test(await refusal(ex.deleteExpense(ORG, r.id))));
const noted = await ex.updateExpense(ORG, r.id, { notes: "Receipt in the file" } as never, ALL);
check("a note still edits, the line kept", noted.notes === "Receipt in the file" && (await linesOf(bank.id)).length === 1 && (await balanceOf(bank.id)) === START - 20_000);
let t = await expense();
t = await ex.markExpensePaid(ORG, t.id, { paidOn: "2026-10-14" } as never);
await BankTransaction.updateMany({ accountId: new Types.ObjectId(petty.id) }, { $set: { isReconciled: true } });
t = await ex.updateExpense(ORG, t.id, { amountMinor: 25_000 } as never, ALL);
check("a petty cash tin's counted line still moves", (await balanceOf(petty.id)) === START - 25_000, String(await balanceOf(petty.id)));
await ex.deleteExpense(ORG, t.id);

/* ── 5 ── */
step("5. Made already paid elsewhere (salary advance, one-time payment)");
const made = await Expense.create({ organizationId: org._id, expenseNumber: "EXP-ADV-1", category: "other", categoryName: "Other", description: "Salary advance",
  expenseDate: new Date("2026-10-15"), amountMinor: 40_000, taxMinor: 0, totalMinor: 40_000, currency: "AED", paymentMethod: "cash",
  paidOn: new Date("2026-10-15"), status: "approved", submittedById: asha._id, submittedByName: "Asha" });
await ex.placeExpenseInBank(ORG, made._id);
const placed = await Expense.findById(made._id).lean<any>();
check("cash → Delta Petty, with its line", String(placed.bankAccountId) === petty.id && !!placed.bankTransactionId && (await balanceOf(petty.id)) === START - 40_000, j(placed));

/* ── 6 ── */
step("6. A bill payment");
const vendor = await Vendor.create({ organizationId: org._id, vendorCode: "VEN-00001", name: "Gulf Supplies", email: "a@e2e-out.test", phone: "+971400000000", currency: "AED", status: "active" });
const b = await bills.createBill(ORG, { category: "office_supplies", subcategory: "stationery", vendorId: String(vendor._id), billDate: "2026-10-10", dueDate: "2026-10-20", currency: "AED",
  lineItems: [{ description: "Paper", quantity: 1, unitPriceMinor: 100_000, discountPct: 0, taxPct: 0 }], notes: "", paymentTerms: "", requiresApproval: false } as never);
const bankBefore = await balanceOf(bank.id);
let bd = await bills.recordBillPayment(ORG, b.id, { method: "bank_transfer", amountMinor: 60_000, paidOn: "2026-10-15", reference: "", accountName: "", notes: "", chargesMinor: 0 } as never);
let bp = bd.payments.at(-1)!;
let bl = (await linesOf(bank.id)).find((l) => l.matches?.[0]?.type === "bill");
check("bank transfer → Delta Bank, a debit of AED 600 matched to the bill", bp.bankAccountId === bank.id && bp.accountName === "Delta Bank" && bp.inBank === true
  && bl?.amountMinor === -60_000 && bl?.matches[0]?.referenceId === b.id && (await balanceOf(bank.id)) === bankBefore - 60_000, j({ bp, bl }));
bd = await bills.updateBillPayment(ORG, b.id, bp.id, { method: "bank_transfer", amountMinor: 70_000, paidOn: "2026-10-15", reference: "", accountName: "", notes: "", chargesMinor: 0 } as never);
check("edited to AED 700: the line follows", (await balanceOf(bank.id)) === bankBefore - 70_000);
const pettyBefore = await balanceOf(petty.id);
bd = await bills.updateBillPayment(ORG, b.id, bp.id, { method: "bank_transfer", amountMinor: 70_000, paidOn: "2026-10-15", reference: "", accountName: "", bankAccountId: petty.id, notes: "", chargesMinor: 0 } as never);
check("moved to Delta Petty", (await balanceOf(bank.id)) === bankBefore && (await balanceOf(petty.id)) === pettyBefore - 70_000 && bd.payments.at(-1)!.accountName === "Delta Petty");
bd = await bills.deleteBillPayment(ORG, b.id, bp.id);
check("deleted: the line goes", (await balanceOf(petty.id)) === pettyBefore && !(await BankTransaction.exists({ "matches.type": "bill" })));
bd = await bills.recordBillPayment(ORG, b.id, { method: "card", amountMinor: 10_000, paidOn: "2026-10-15", reference: "", accountName: "", bankAccountId: "", notes: "", chargesMinor: 0 } as never);
check("\"\" — not in a bank account: no line", !bd.payments.at(-1)!.bankAccountId && !(await BankTransaction.exists({ "matches.type": "bill" })));
check("another organization's account is refused", /not one of this organization's/.test(await refusal(bills.recordBillPayment(ORG, b.id, { method: "card", amountMinor: 1_000, paidOn: "2026-10-15", bankAccountId: theirs.id } as never))));

/* ── 7 ── */
step("7. The backfill (bank-accounts-backfill.ts)");
// What was there before: no settings, payments and expenses in no account, typed text.
await Organization.updateOne({ _id: org._id }, { $set: { paymentAccounts: {} } });
const { customer } = await findOrCreateCustomer(ORG, { name: "Client One", email: "one@e2e-out.test", phone: "+971500000000" } as never);
const iv = await inv.createInvoice(ORG, { customerId: customer.id, salespersonId: ASHA, issueDate: "2026-10-01", dueDate: "2026-10-01", currency: "AED",
  reference: "E2E-1", notes: "", taxInclusive: true, lineItems: [{ description: "Course", quantity: 1, unitPriceMinor: 500_000, taxes: [] }] } as never, ALL as never);
await Invoice.updateOne({ _id: iv.id }, { $set: { status: "sent" } });
for (const method of ["tabby", "cash", "other"]) {
  await inv.recordPayment(ORG, iv.id, { method, amountMinor: 100_000, paidOn: "2026-10-02", reference: "", notes: "", accountName: "", chargesMinor: 0, bankAccountId: "" } as never);
}
const old = (over: Record<string, unknown>) => Expense.create({ organizationId: org._id, category: "other", categoryName: "Other", description: "Old",
  expenseDate: new Date("2026-09-01"), amountMinor: 15_000, taxMinor: 0, totalMinor: 15_000, currency: "AED", status: "approved",
  submittedById: asha._id, submittedByName: "Asha", ...over });
const adcb = await old({ expenseNumber: "EXP-OLD-1", paymentMethod: "cash", paymentAccount: "ADCB", paidOn: new Date("2026-09-02") });
const blankCash = await old({ expenseNumber: "EXP-OLD-2", paymentMethod: "cash", paymentAccount: "" });
const online = await old({ expenseNumber: "EXP-OLD-3", paymentMethod: "online", paymentAccount: "Main current" });
await old({ expenseNumber: "EXP-OLD-4", paymentMethod: "bank_transfer", paymentAccount: "Bank", status: "voided", paidOn: new Date("2026-09-02") });
const b2 = await bills.createBill(ORG, { category: "office_supplies", subcategory: "stationery", vendorId: String(vendor._id), billDate: "2026-09-10", dueDate: "2026-09-20", currency: "AED",
  lineItems: [{ description: "Chairs", quantity: 1, unitPriceMinor: 50_000, discountPct: 0, taxPct: 0 }], notes: "", paymentTerms: "", requiresApproval: false } as never);
await bills.recordBillPayment(ORG, b2.id, { method: "cheque", amountMinor: 50_000, paidOn: "2026-09-15", reference: "", accountName: "", bankAccountId: "", notes: "", chargesMinor: 0 } as never);

const map = { cash: "Delta Petty", tabby: "Delta Bank", cheque: "Delta Bank", bank_transfer: "Delta Bank", inr_bank_account: "Yaroon" };
const snap = async () => ({ bank: await balanceOf(bank.id), petty: await balanceOf(petty.id), lines: await BankTransaction.countDocuments({}) });
const s0 = await snap();
const dry = await backfillBankAccounts({ orgId: ORG, map, textAccount: "Delta Bank", write: false });
check("dry run: 5 settings", dry.mapping.length === 5, j(dry.mapping));
check("dry run: tabby and cash invoice payments, \"other\" left", dry.invoicePayments.length === 2 && dry.invoicePayments.some((p) => p.method === "tabby" && p.account === "Delta Bank")
  && dry.invoicePayments.some((p) => p.method === "cash" && p.account === "Delta Petty"), j(dry.invoicePayments));
const ex1 = dry.expenses.find((x) => x.expenseNumber === "EXP-OLD-1"), ex2 = dry.expenses.find((x) => x.expenseNumber === "EXP-OLD-2");
check("dry run: typed \"ADCB\" → Delta Bank (not its method's petty cash); blank cash → Delta Petty", ex1?.account === "Delta Bank" && ex2?.account === "Delta Petty", j(dry.expenses));
check("dry run: \"online\" with no account and the voided one left", !dry.expenses.some((x) => ["EXP-OLD-3", "EXP-OLD-4"].includes(x.expenseNumber)), j(dry.expenses));
check("dry run: the bill's cheque payment → Delta Bank", dry.billPayments.length === 1 && dry.billPayments[0]!.account === "Delta Bank", j(dry.billPayments));
const s1 = await snap();
check("dry run writes nothing", JSON.stringify(s0) === JSON.stringify(s1) && !(await Organization.findById(org._id).lean<any>()).paymentAccounts?.cash, j({ s0, s1 }));
check("an unknown account name is reported", (await backfillBankAccounts({ orgId: ORG, map: { cash: "Petty Tin" }, write: false })).unknownAccounts[0] === "Petty Tin");
check("…and refuses to write", /No open account called Petty Tin/.test(await refusal(backfillBankAccounts({ orgId: ORG, map: { cash: "Petty Tin" }, write: true, backupDir: os.tmpdir() }))));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "money-out-backup-"));
const done = await backfillBankAccounts({ orgId: ORG, map, textAccount: "Delta Bank", write: true, backupDir: dir });
const s2 = await snap();
const files = fs.readdirSync(dir);
check("a backup written first", files.length === 1 && JSON.parse(fs.readFileSync(path.join(dir, files[0]!), "utf8")).expenses.length === done.expenses.length, files.join(","));
const o = await Organization.findById(org._id).lean<any>();
check("settings saved", String(o.paymentAccounts.cash) === petty.id && String(o.paymentAccounts.tabby) === bank.id && String(o.paymentAccounts.inr_bank_account) === yaroon.id, j(o.paymentAccounts));
const ivNow = await Invoice.findById(iv.id).lean<any>();
const byMethod = (m: string) => ivNow.payments.find((p: any) => p.method === m);
check("invoice payments in their accounts: tabby → Delta Bank, cash → Delta Petty, other none",
  String(byMethod("tabby").bankAccountId) === bank.id && String(byMethod("cash").bankAccountId) === petty.id && !byMethod("other").bankAccountId);
check("…as credits: bank +1,000 −150 −500, petty +1,000", s2.bank === s1.bank + 100_000 - 15_000 - 50_000 && s2.petty === s1.petty + 100_000, j({ s1, s2 }));
const adcbNow = await Expense.findById(adcb._id).lean<any>();
check("the ADCB expense: Delta Bank, named so, its money-out line", String(adcbNow.bankAccountId) === bank.id && adcbNow.paymentAccount === "Delta Bank" && !!adcbNow.bankTransactionId, j(adcbNow));
const blankNow = await Expense.findById(blankCash._id).lean<any>();
check("the unpaid cash one: Delta Petty, no line until paid", String(blankNow.bankAccountId) === petty.id && !blankNow.bankTransactionId);
check("the online one: untouched, its typed text kept", (await Expense.findById(online._id).lean<any>()).paymentAccount === "Main current");
const b2Now = await Bill.findById(b2.id).lean<any>();
check("the bill payment: Delta Bank, with its line", String(b2Now.payments[0].bankAccountId) === bank.id && !!b2Now.payments[0].bankTransactionId);
const again = await backfillBankAccounts({ orgId: ORG, map, textAccount: "Delta Bank", write: true, backupDir: dir });
check("run again: nothing to do, nothing moves", again.mapping.length + again.invoicePayments.length + again.expenses.length + again.billPayments.length === 0
  && JSON.stringify(await snap()) === JSON.stringify(s2), j(again));
check("only this organization's", (await BankTransaction.countDocuments({ organizationId: other._id })) === 0);
fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} passed`);
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
