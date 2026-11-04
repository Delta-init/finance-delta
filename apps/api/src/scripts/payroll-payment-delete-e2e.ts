/**
 * Deleting the expense a payroll payment posted takes the payment with it, from everywhere it reached (the user,
 * 2026-11-04: "still it's showing … we delete it, it will delete from its connected areas also") — against a scratch
 * database. HRMS is never called: the payments here were never told to it.
 *
 * What it proves:
 *   - the delete dialog's preview says which run and payment, reversed or not, who it paid, reconciled or not;
 *   - a payment already reversed: deleting its (voided) expense removes the expense, both bank lines (out and back in),
 *     the account's balance and running balances as if neither had been, and the payment from the run — remembered in
 *     deletedPayments;
 *   - a payment still standing: refused without a reason; with one, it is reversed (the person owed again, the run
 *     back to approved) and then everything goes as above;
 *   - either bank line reconciled against a statement: refused, nothing reversed, nothing gone;
 *   - the next payment's number is never one already used;
 *   - an ordinary expense still deletes as before.
 *
 * Run through scripts/payroll-payment-delete-e2e.sh (throwaway mongod, no .env anywhere).
 */
import mongoose, { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}
const { PayrollRun } = await import("../modules/payroll/payroll-run.model");
const { BankAccount } = await import("../modules/banking/bank-account.model");
const { BankTransaction } = await import("../modules/banking/bank-transaction.model");
const { Expense } = await import("../modules/expense/expense.model");
const { reversePayment, payrollPaymentOfExpense } = await import("../modules/payroll/payment.service");
const { deleteExpense } = await import("../modules/expense/expense.service");
const { recalculateRunningBalances } = await import("../modules/banking/banking.service");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const j = (v: unknown) => String(JSON.stringify(v)).slice(0, 500);
const errOf = async (f: () => Promise<unknown>) => { try { await f(); return ""; } catch (e) { return (e as Error).message; } };

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();

const ORG = new Types.ObjectId();
const org = String(ORG);
const bank = await BankAccount.create({ organizationId: ORG, accountName: "Delta Bank", accountType: "current", currency: "AED", openingBalanceMinor: 10_000_000, currentBalanceMinor: 10_000_000, openingDate: new Date("2026-10-01") });
// Something else on the account, before and after, so the running balances have something to be wrong about.
await BankTransaction.create({ organizationId: ORG, accountId: bank._id, accountName: "Delta Bank", currency: "AED", date: new Date("2026-10-28"), description: "Deposit", amountMinor: 500_000, type: "credit", runningBalanceMinor: 0 });
await BankTransaction.create({ organizationId: ORG, accountId: bank._id, accountName: "Delta Bank", currency: "AED", date: new Date("2026-11-03"), description: "Rent", amountMinor: -200_000, type: "debit", runningBalanceMinor: 0 });
await recalculateRunningBalances(org, bank._id);
const before = { balance: (await BankAccount.findById(bank._id).lean<any>())!.currentBalanceMinor, lines: await BankTransaction.find({ accountId: bank._id }).sort({ date: 1 }).lean<any[]>() };

const line = (name: string, payableMinor: number) => ({ _id: new Types.ObjectId(), hrmsPayslipId: `ps-${name}`, hrmsEmployeeId: `e-${name}`, employeeCode: name, name, grossMinor: payableMinor, deductionsMinor: 0, netFromHrmsMinor: payableMinor, payableMinor, amountPaidMinor: 0, status: "pending" });
const A = line("Asha", 300_000), B = line("Bilal", 150_000), C = line("Chris", 100_000);
const run = await PayrollRun.create({ organizationId: ORG, hrmsOrgId: "h1", runNumber: "PAY-202610-002", period: "2026-10", currency: "AED", status: "approved", lines: [A, B, C] });

/** A payment as payRun leaves it — bank line, expense, the person paid — never told to HRMS. */
async function pay(who: typeof A, n: number) {
  const r = (await PayrollRun.findById(run._id))!;
  const paymentId = `${r.runNumber}-P${n}`;
  const tx = await BankTransaction.create({ organizationId: ORG, accountId: bank._id, accountName: "Delta Bank", currency: "AED", date: new Date("2026-11-02"), description: `Payroll ${r.runNumber}`, reference: paymentId, amountMinor: -who.payableMinor, type: "debit", runningBalanceMinor: 0, status: "matched", matches: [{ type: "payroll", referenceId: String(r._id), referenceNumber: r.runNumber, amountMinor: who.payableMinor }] });
  await recalculateRunningBalances(org, bank._id);
  const exp = await Expense.create({ organizationId: ORG, expenseNumber: `EXP-0026${n}`, category: "payroll", categoryName: "Payroll", description: `Payroll ${r.runNumber} · 2026-10 · 1 people`, expenseDate: new Date("2026-11-02"), amountMinor: who.payableMinor, taxPct: 0, taxMinor: 0, totalMinor: who.payableMinor, currency: "AED", paymentAccount: "Delta Bank", paymentMethod: "bank_transfer", submittedById: new Types.ObjectId(), submittedByName: "Admin", status: "approved" });
  const l = r.lines.find((x) => x.name === who.name)!;
  l.amountPaidMinor = who.payableMinor; l.status = "paid";
  r.amountPaidMinor = (r.amountPaidMinor ?? 0) + who.payableMinor;
  r.status = "partially_paid";
  r.payments.push({ paymentId, method: "bank_transfer", paidOn: new Date("2026-11-02"), bankAccountId: bank._id, bankAccountName: "Delta Bank", bankTransactionId: tx._id, currency: "AED", amountMinor: who.payableMinor, allocations: [{ lineId: l._id, amountMinor: who.payableMinor }], syncedToHrms: false, expenseId: exp._id } as never);
  await r.save();
  return { paymentId, expenseId: String(exp._id), txId: tx._id };
}
const balanceNow = async () => (await BankAccount.findById(bank._id).lean<any>())!.currentBalanceMinor;
const sameLinesAsBefore = async () => {
  const now = await BankTransaction.find({ accountId: bank._id }).sort({ date: 1 }).lean<any[]>();
  return j(now.map((x) => [x.description, x.amountMinor, x.runningBalanceMinor])) === j(before.lines.map((x) => [x.description, x.amountMinor, x.runningBalanceMinor]));
};

step("1. A payment already reversed — its voided expense deleted");
const p1 = await pay(A, 1);
await reversePayment(org, String(run._id), p1.paymentId, "Recorded by mistake");
const pre1 = await payrollPaymentOfExpense(org, p1.expenseId);
check("the dialog's preview: run, payment, reversed, who, not reconciled", pre1?.runNumber === "PAY-202610-002" && pre1.paymentId === "PAY-202610-002-P1" && pre1.reversed && j(pre1.people) === j(["Asha"]) && !pre1.reconciled, j(pre1));
check("before: the expense voided, two lines on the account (out and back in)", (await Expense.findById(p1.expenseId).lean<any>())?.status === "voided" && (await BankTransaction.countDocuments({ accountId: bank._id })) === 4);
await deleteExpense(org, p1.expenseId, { actor: { name: "Admin" } });
let r1 = (await PayrollRun.findById(run._id).lean<any>())!;
check("the expense is gone", !(await Expense.exists({ _id: p1.expenseId })));
check("both its bank lines gone; the account and every other line's running balance as if it never was", (await balanceNow()) === before.balance && (await sameLinesAsBefore()), j({ bal: await balanceNow(), before: before.balance }));
check("the payment gone from the run, remembered in deletedPayments with its reason", r1.payments.length === 0 && r1.deletedPayments.length === 1 && r1.deletedPayments[0].paymentId === "PAY-202610-002-P1" && r1.deletedPayments[0].expenseNumber === "EXP-00261" && /by mistake/.test(r1.deletedPayments[0].reason), j(r1.deletedPayments));
check("Asha owed again, the run back to approved", r1.lines.find((l: any) => l.name === "Asha").status === "pending" && r1.status === "approved", j({ s: r1.status }));

step("2. A payment still standing — reversed, then deleted");
const p2 = await pay(B, 2);
check("refused without a reason, nothing changed", /Say why/.test(await errOf(() => deleteExpense(org, p2.expenseId, {}))) && (await Expense.exists({ _id: p2.expenseId })) !== null
  && (await PayrollRun.findById(run._id).lean<any>())!.payments[0].reversedAt === null);
await deleteExpense(org, p2.expenseId, { reason: "Paid twice", actor: { name: "Admin" } });
r1 = (await PayrollRun.findById(run._id).lean<any>())!;
check("reversed and deleted: Bilal owed again, expense and bank lines gone, balance as before", r1.lines.find((l: any) => l.name === "Bilal").status === "pending" && r1.amountPaidMinor === 0
  && !(await Expense.exists({ _id: p2.expenseId })) && (await balanceNow()) === before.balance && (await sameLinesAsBefore()), j({ bal: await balanceNow() }));
check("…remembered too", r1.payments.length === 0 && j(r1.deletedPayments.map((d: any) => [d.paymentId, d.reason])) === j([["PAY-202610-002-P1", "Recorded by mistake"], ["PAY-202610-002-P2", "Paid twice"]]));

step("3. Reconciled against a statement — refused, nothing done");
const p3 = await pay(C, 3);
await BankTransaction.updateOne({ _id: p3.txId }, { $set: { isReconciled: true } });
const pre3 = await payrollPaymentOfExpense(org, p3.expenseId);
const refused3 = await errOf(() => deleteExpense(org, p3.expenseId, { reason: "Wrong", actor: { name: "Admin" } }));
r1 = (await PayrollRun.findById(run._id).lean<any>())!;
check("the preview says reconciled; deleting refused; not reversed; nothing gone", pre3?.reconciled === true && /reconciled/.test(refused3) && r1.payments.length === 1 && !r1.payments[0].reversedAt
  && r1.lines.find((l: any) => l.name === "Chris").status === "paid" && (await Expense.exists({ _id: p3.expenseId })) !== null, refused3);

step("4. Numbers never handed out twice, and ordinary expenses as before");
const src = await Bun.file(new URL("../modules/payroll/payment.service.ts", import.meta.url)).text();
check("the next payment number counts the deleted ones (3 payments ever → P4)", /run\.payments\.length \+ \(\(run as unknown as \{ deletedPayments\?: unknown\[\] \}\)\.deletedPayments\?\.length \?\? 0\) \+ 1/.test(src)
  && r1.payments.length + r1.deletedPayments.length + 1 === 4);
const plain = await Expense.create({ organizationId: ORG, expenseNumber: "EXP-00300", category: "office", categoryName: "Office", description: "Pens", expenseDate: new Date("2026-11-02"), amountMinor: 1_000, taxPct: 0, taxMinor: 0, totalMinor: 1_000, currency: "AED", submittedById: new Types.ObjectId(), submittedByName: "Admin", status: "approved" });
check("an ordinary expense: no payroll preview, deletes as before", (await payrollPaymentOfExpense(org, String(plain._id))) === null && (await errOf(() => deleteExpense(org, String(plain._id)))) === "" && !(await Expense.exists({ _id: plain._id })));

await mongoose.disconnect();
console.log(`\n${failures ? "\x1b[31m" : "\x1b[32m"}${checks - failures}/${checks} checks passed\x1b[0m`);
process.exit(failures ? 1 : 0);
