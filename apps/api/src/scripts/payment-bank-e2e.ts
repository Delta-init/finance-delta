/**
 * Where payments go, and their lines in the bank (the user, 2026-10-16: "INR payment will go under the bank Yaroon
 * Bank … Tabby, Tamara, Smart invoice, Card — Bank Account, and Cash to Petty cash … edit also after the approval …
 * show in bank") — finance's services in this process, on a scratch database:
 *
 *   1. Settings: each method's account, only this organization's accounts, "" clears one.
 *   2. Recorded by hand: its method's account, a matched credit in it, the balance up — or the one picked, or none.
 *   3. Charges: what lands is the payment less them — shown as two lines (2026-10-16): the full payment's credit and
 *      its charges' debit, each matched to the invoice; the balance moves by what landed.
 *   4. Edited (after approval too): another account — the line moves; another amount or date — the line follows;
 *      none — the line goes. Deleted: the line goes and the balance with it.
 *   5. An INR account for an AED invoice: kept, out of the balance, saying why, until the rupees are given.
 *   6. An enrolment's approval: the close's payments go to their methods' accounts — cash to petty cash, the rupees
 *      as the client handed them over to the INR account.
 *   7. A CS Portal course payment ("INR TRANSFER") lands in the INR account.
 *   8. A bank statement reconciled against a line: the payment's account, amount and date no longer move; a petty
 *      cash tin's still do.
 *   9. The backfill (charges-lines-backfill.ts): a payment from before, one net line, becomes the two — the balance
 *      the same; a reconciled one is left; run again, nothing to do.
 *
 * Run through scripts/payment-bank-e2e.sh. Scratch databases only.
 */
import mongoose, { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}

const { Organization } = await import("../modules/organization/organization.model");
const { User } = await import("../modules/user/user.model");
const { Invoice } = await import("../modules/invoice/invoice.model");
const { BankAccount } = await import("../modules/banking/bank-account.model");
const { BankTransaction } = await import("../modules/banking/bank-transaction.model");
const { createBankAccount } = await import("../modules/banking/banking.service");
const { updateOrganization } = await import("../modules/organization/organization.service");
const inv = await import("../modules/invoice/invoice.service");
const { findOrCreateCustomer } = await import("../modules/customer/customer.service");
const { recordCoursePayment } = await import("../modules/tetra-deposit/course-invoice");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const j = (v: unknown) => JSON.stringify(v).slice(0, 400);
const refusal = async (p: Promise<unknown>) => p.then(() => "", (e: Error) => e.message);

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();

const org = await Organization.create({ name: "Delta HQ E2E", baseCurrency: "AED" });
const other = await Organization.create({ name: "Other E2E", baseCurrency: "AED" });
const ORG = String(org._id);
const asha = await User.create({ name: "Asha Accountant", email: "asha@e2e-bank.test", passwordHash: "x", status: "active", memberships: [{ organizationId: org._id, roleId: new Types.ObjectId(), status: "active" }] });
const acct = (accountName: string, currency: string, accountType = "current", orgId = ORG) =>
  createBankAccount(orgId, { accountName, currency, accountType, openingBalanceMinor: 0, openingDate: "2026-01-01" } as never);
const bank = await acct("Bank Account", "AED");
const petty = await acct("Petty Cash", "AED", "petty_cash");
const yaroon = await acct("Yaroon Bank", "INR");
const theirs = await acct("Someone Else's", "AED", "current", String(other._id));
const balanceOf = async (id: string) => (await BankAccount.findById(id).lean<any>())?.currentBalanceMinor ?? 0;
const linesOf = (id: string) => BankTransaction.find({ accountId: new Types.ObjectId(id) }).lean<any[]>();

const { customer } = await findOrCreateCustomer(ORG, { name: "Client One", email: "one@e2e-bank.test", phone: "+971500000000" } as never);
let n = 0;
const invoice = async (totalMinor: number) => {
  const made = await inv.createInvoice(ORG, {
    customerId: customer.id, salespersonId: String(asha._id), issueDate: "2026-10-16", dueDate: "2026-10-16", currency: "AED",
    reference: `E2E-${++n}`, notes: "", taxInclusive: true, lineItems: [{ description: "Course", quantity: 1, unitPriceMinor: totalMinor, taxes: [] }],
  } as never, { all: true } as never);
  await Invoice.updateOne({ _id: made.id }, { $set: { status: "sent" } });
  return made.id as string;
};
const pay = (id: string, over: Record<string, unknown>) => inv.recordPayment(ORG, id, {
  method: "tabby", amountMinor: 100_000, paidOn: "2026-10-16", reference: "", notes: "", accountName: "", chargesMinor: 0, ...over,
} as never);
const lastPayment = (dto: any) => dto.payments[dto.payments.length - 1];

/* ── 1 ── */
step("1. Settings: each method's account");
let r = await updateOrganization(ORG, { paymentAccounts: { inr_bank_account: yaroon.id, tabby: bank.id, tamara: bank.id, billexpro: bank.id, card: bank.id, cash: petty.id } });
check("Delta HQ's: INR → Yaroon Bank, Tabby/Tamara/Smart invoice/Card → Bank Account, Cash → Petty Cash",
  r.paymentAccounts.inr_bank_account === yaroon.id && r.paymentAccounts.billexpro === bank.id && r.paymentAccounts.cash === petty.id, j(r.paymentAccounts));
check("another organization's account is refused", /one of this organization's/.test(await refusal(updateOrganization(ORG, { paymentAccounts: { cheque: theirs.id } }))));
check("an unknown method is refused", /Unknown payment method/.test(await refusal(updateOrganization(ORG, { paymentAccounts: { crypto: bank.id } }))));
r = await updateOrganization(ORG, { paymentAccounts: { cheque: bank.id } });
r = await updateOrganization(ORG, { paymentAccounts: { cheque: "" } });
check("\"\" clears one, the others kept", !r.paymentAccounts.cheque && r.paymentAccounts.tabby === bank.id, j(r.paymentAccounts));

/* ── 2 ── */
step("2. Recorded by hand: into its method's account, matched to the invoice");
const i1 = await invoice(1_000_000);
let d = await pay(i1, { method: "tabby", amountMinor: 200_000 });
let p = lastPayment(d);
check("the payment says Bank Account, in the account", p.accountName === "Bank Account" && p.bankAccountId === bank.id && p.inBank === true && !p.bankNote, j(p));
let lines = await linesOf(bank.id);
check("one credit of AED 2,000 in Bank Account, matched to the invoice", lines.length === 1 && lines[0].amountMinor === 200_000 && lines[0].type === "credit" && lines[0].status === "matched" && lines[0].matches[0]?.referenceId === i1, j(lines));
check("its balance is AED 2,000", (await balanceOf(bank.id)) === 200_000);
d = await pay(i1, { method: "tabby", amountMinor: 50_000, bankAccountId: petty.id });
check("one picked by hand goes there instead", lastPayment(d).bankAccountId === petty.id && (await balanceOf(petty.id)) === 50_000);
d = await pay(i1, { method: "cash", amountMinor: 10_000, bankAccountId: "" });
check("\"\" — not in a bank account: no line anywhere", !lastPayment(d).bankAccountId && (await balanceOf(petty.id)) === 50_000 && lastPayment(d).inBank === undefined, j(lastPayment(d)));
d = await pay(i1, { method: "bank_transfer", amountMinor: 10_000 });
check("a method with no account: none, as before", !lastPayment(d).bankAccountId);
check("another organization's account can't be picked", /not one of this organization's/.test(await refusal(pay(i1, { amountMinor: 1_000, bankAccountId: theirs.id }))));

/* ── 3 ── */
step("3. Charges: the payment less them lands — as two lines");
d = await pay(i1, { method: "card", amountMinor: 100_000, chargesMinor: 2_500 });
check("AED 1,000 by card, AED 25 charges → AED 975 in Bank Account", lastPayment(d).bankAmountMinor === 97_500 && (await balanceOf(bank.id)) === 297_500, String(await balanceOf(bank.id)));
const cardId = lastPayment(d).id;
{
  const ls = await linesOf(bank.id);
  const credit = ls.find((l) => l.type === "credit" && l.amountMinor === 100_000);
  const debit = ls.find((l) => l.type === "debit" && l.amountMinor === -2_500);
  check("two lines: a credit of the full AED 1,000 (as the invoice shows it) and a debit of the AED 25 charges",
    !!credit && !!debit && /charges$/.test(debit.description) && debit.matches?.[0]?.referenceId === i1 && debit.matches?.[0]?.amountMinor === 2_500, j(ls));
}
d = await pay(i1, { method: "cash", amountMinor: 1_000, chargesMinor: 0, bankAccountId: petty.id });
check("no charges: one line, as before", (await linesOf(petty.id)).filter((l) => l.matches?.[0]?.referenceId === i1 && l.amountMinor === 1_000).length === 1
  && !(await linesOf(petty.id)).some((l) => l.type === "debit"));
await inv.deletePayment(ORG, i1, lastPayment(d).id);

/* ── 4 ── */
step("4. Edited (after approval too) and deleted: the line follows");
const edit = (id: string, pid: string, over: Record<string, unknown>) => inv.updatePayment(ORG, id, pid, {
  method: "card", amountMinor: 100_000, paidOn: "2026-10-16", reference: "", notes: "", accountName: "", chargesMinor: 2_500, ...over,
} as never);
d = await edit(i1, cardId, { bankAccountId: petty.id });
check("moved to Petty Cash: out of Bank Account, into Petty Cash", (await balanceOf(bank.id)) === 200_000 && (await balanceOf(petty.id)) === 147_500 && d.payments.find((x: any) => x.id === cardId)?.accountName === "Petty Cash", `${await balanceOf(bank.id)} / ${await balanceOf(petty.id)}`);
d = await edit(i1, cardId, { bankAccountId: petty.id, amountMinor: 120_000, paidOn: "2026-10-10" });
const pl = (await linesOf(petty.id)).find((l) => l.amountMinor === 120_000);
const pc = (await linesOf(petty.id)).find((l) => l.amountMinor === -2_500);
check("another amount and date: both lines follow (AED 1,200 less 25, on 10 Oct)", !!pl && !!pc && new Date(pl.date).toISOString().slice(0, 10) === "2026-10-10"
  && new Date(pc.date).toISOString().slice(0, 10) === "2026-10-10" && (await balanceOf(petty.id)) === 167_500, j(await linesOf(petty.id)));
d = await edit(i1, cardId, { bankAccountId: "", amountMinor: 120_000 });
check("none: its line goes", (await balanceOf(petty.id)) === 50_000 && !d.payments.find((x: any) => x.id === cardId)?.bankAccountId);
d = await edit(i1, cardId, { bankAccountId: bank.id, amountMinor: 120_000 });
check("and back into Bank Account", (await balanceOf(bank.id)) === 317_500);
await inv.deletePayment(ORG, i1, cardId);
check("deleted: both its lines and its money gone from Bank Account", (await balanceOf(bank.id)) === 200_000 && (await linesOf(bank.id)).length === 1);

/* ── 5 ── */
step("5. The INR account for an AED invoice");
const i2 = await invoice(2_000_000);
d = await pay(i2, { method: "inr_bank_account", amountMinor: 367_000 });
p = lastPayment(d);
check("kept against Yaroon Bank, out of its balance, saying why", p.bankAccountId === yaroon.id && p.inBank === false && /Yaroon Bank is in INR/.test(p.bankNote ?? "") && (await balanceOf(yaroon.id)) === 0, j(p));
d = await edit(i2, p.id, { method: "inr_bank_account", amountMinor: 367_000, chargesMinor: 0, bankAccountId: yaroon.id, bankAmountMinor: 10_000_000 });
p = d.payments.find((x: any) => x.id === p.id);
check("the rupees given: ₹100,000 in Yaroon Bank", p.inBank === true && !p.bankNote && p.bankAmountMinor === 10_000_000 && p.bankCurrency === "INR" && (await balanceOf(yaroon.id)) === 10_000_000, j(p));
d = await pay(i2, { method: "inr_bank_account", amountMinor: 36_700, bankAmountMinor: 1_000_000 });
check("given when recorded: in straight away", lastPayment(d).inBank === true && (await balanceOf(yaroon.id)) === 11_000_000);

/* ── 6 ── */
step("6. An enrolment's approval: the close's payments to their accounts");
const i3 = await invoice(1_500_000);
await Invoice.updateOne({ _id: i3 }, { $set: {
  status: "draft",
  approval: { state: "pending", submittedAt: new Date() },
  enrolment: { course: "MBT", language: "English", modeOfStudy: "online", declaredPayments: [
    { method: "cash", amountMinor: 500_000, paidOn: "2026-10-15" },
    { method: "inr_bank_account", amountMinor: 367_000, paidOn: "2026-10-15", original: { currency: "INR", amountMinor: 10_000_000, rate: 27.248 } },
  ] },
} });
const pettyBefore = await balanceOf(petty.id), yaroonBefore = await balanceOf(yaroon.id);
d = await inv.approveInvoice(ORG, i3, { userId: String(asha._id), name: "Asha Accountant" });
const cash3 = d.payments.find((x: any) => x.method === "cash")!;
const inr3 = d.payments.find((x: any) => x.method === "inr_bank_account");
check("approved: both payments recorded", d.payments.length === 2 && d.enrolment?.declaredPaymentsOnApproval?.state === "recorded", j(d.enrolment?.declaredPaymentsOnApproval));
check("the cash into Petty Cash (AED 5,000)", cash3?.bankAccountId === petty.id && cash3?.inBank === true && (await balanceOf(petty.id)) - pettyBefore === 500_000, j(cash3));
check("the rupees into Yaroon Bank as handed over (₹100,000)", inr3?.bankAccountId === yaroon.id && inr3?.inBank === true && (await balanceOf(yaroon.id)) - yaroonBefore === 10_000_000, j(inr3));
d = await edit(i3, cash3.id, { method: "cash", amountMinor: 500_000, paidOn: "2026-10-15", chargesMinor: 0, bankAccountId: bank.id });
check("after approval it can still be moved — into Bank Account", d.payments.find((x: any) => x.id === cash3.id)?.bankAccountId === bank.id && (await balanceOf(petty.id)) === pettyBefore);

/* ── 7 ── */
step("7. A CS Portal course payment by INR TRANSFER");
const i4row = {
  _id: new Types.ObjectId(), organizationId: org._id, externalId: String(new Types.ObjectId()), type: "BONUS", currency: "AED",
  amountMinor: 367_000, paymentMethod: "INR TRANSFER", requestedAt: new Date("2026-10-16"),
  student: { id: "s1", code: "STU-1", name: "Student One", email: "stu1@e2e-bank.test" },
  coursePayment: { product: "MSNR", kind: "partial", paidTodayAed: 3670, balanceAed: 5000, paidOn: "2026-10-16" },
  decision: { decidedById: asha._id, decidedByName: "Asha Accountant", approvedAmountMinor: 367_000, transactionId: "T-1" },
};
const { TetraDepositModel } = await import("../modules/tetra-deposit/tetra-deposit.model");
await TetraDepositModel.create({ ...i4row, status: "approved" });
const done = await recordCoursePayment(i4row, { email: false });
const row4 = await TetraDepositModel.findById(i4row._id).lean<any>();
const inv4 = row4?.courseInvoice?.invoiceId ? await Invoice.findById(row4.courseInvoice.invoiceId).lean<any>() : null;
const p4 = inv4?.payments?.[0];
check("recorded as INR Bank Account, against Yaroon Bank", done.ok && p4?.method === "inr_bank_account" && String(p4?.bankAccountId) === yaroon.id, j({ done, m: p4?.method, a: p4?.bankAccountId }));

/* ── 8 ── */
step("8. Reconciled against a bank statement: the line stands");
const i5 = await invoice(500_000);
d = await pay(i5, { method: "tabby", amountMinor: 100_000 });
const p5 = lastPayment(d);
await BankTransaction.updateOne({ _id: (await Invoice.findById(i5).lean<any>()).payments[0].bankTransactionId }, { $set: { isReconciled: true } });
check("moving it to another account is refused", /reconciled against a bank statement/.test(await refusal(edit(i5, p5.id, { method: "tabby", amountMinor: 100_000, chargesMinor: 0, bankAccountId: petty.id }))));
check("so is deleting it", /reconciled/.test(await refusal(inv.deletePayment(ORG, i5, p5.id))));
d = await edit(i5, p5.id, { method: "tabby", amountMinor: 100_000, chargesMinor: 0, bankAccountId: bank.id, notes: "checked" });
check("a note can still change", d.payments.find((x: any) => x.id === p5.id)?.notes === "checked");
d = await pay(i5, { method: "cash", amountMinor: 50_000 });
const p6 = lastPayment(d);
await BankTransaction.updateOne({ _id: (await Invoice.findById(i5).lean<any>()).payments[1].bankTransactionId }, { $set: { isReconciled: true } });
d = await edit(i5, p6.id, { method: "cash", amountMinor: 40_000, chargesMinor: 0, bankAccountId: petty.id });
check("a petty cash tin's counted line still moves", d.payments.find((x: any) => x.id === p6.id)?.amountMinor === 40_000);

/* ── 9 ── */
step("9. The backfill: a payment from before, as one net line, becomes two");
{
  const { splitChargesLines } = await import("./charges-lines-backfill");
  const i9 = await invoice(500_000);
  d = await pay(i9, { method: "tamara", amountMinor: 200_000, chargesMinor: 10_000 });
  const p9 = lastPayment(d);
  // As it was before 2026-10-16: one credit of the payment less charges, no charges line.
  const doc9 = await Invoice.findById(i9).lean<any>();
  const pp = doc9.payments.find((x: any) => String(x._id) === p9.id);
  await BankTransaction.deleteOne({ _id: pp.bankChargesTransactionId });
  await BankTransaction.updateOne({ _id: pp.bankTransactionId }, { $set: { amountMinor: 190_000 } });
  await Invoice.updateOne({ _id: i9, "payments._id": pp._id }, { $set: { "payments.$.bankChargesTransactionId": null } });
  const { recalculateRunningBalances } = await import("../modules/banking/banking.service");
  await recalculateRunningBalances(ORG, new Types.ObjectId(bank.id));
  const before = await balanceOf(bank.id);
  let rows = await splitChargesLines({ write: false, invoices: [doc9.invoiceNumber] });
  check("dry run: one payment would be split, nothing written", rows.length === 1 && !rows[0]!.skipped && (await linesOf(bank.id)).filter((l) => l.matches?.[0]?.referenceId === i9).length === 1, j(rows));
  const backupDir = (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "charges-lines-"));
  rows = await splitChargesLines({ write: true, invoices: [doc9.invoiceNumber], backupDir });
  const mine = (await linesOf(bank.id)).filter((l) => l.matches?.[0]?.referenceId === i9);
  check("written: a credit of the full AED 2,000 and a debit of the AED 100 charges, the balance the same",
    rows[0]?.done === true && mine.length === 2 && mine.some((l) => l.amountMinor === 200_000) && mine.some((l) => l.amountMinor === -10_000) && (await balanceOf(bank.id)) === before, j({ rows, mine, before, now: await balanceOf(bank.id) }));
  check("…the line it replaced kept in the backup", (await import("node:fs")).readdirSync(backupDir).length === 1);
  rows = await splitChargesLines({ write: false, invoices: [doc9.invoiceNumber] });
  check("run again: nothing to do", rows.length === 0, j(rows));
  // A reconciled one is left as it was.
  d = await pay(i9, { method: "tamara", amountMinor: 100_000, chargesMinor: 5_000 });
  const q = (await Invoice.findById(i9).lean<any>()).payments.find((x: any) => String(x._id) === lastPayment(d).id);
  await BankTransaction.deleteOne({ _id: q.bankChargesTransactionId });
  await BankTransaction.updateOne({ _id: q.bankTransactionId }, { $set: { amountMinor: 95_000, isReconciled: true } });
  await Invoice.updateOne({ _id: i9, "payments._id": q._id }, { $set: { "payments.$.bankChargesTransactionId": null } });
  rows = await splitChargesLines({ write: true, invoices: [doc9.invoiceNumber], backupDir });
  check("a payment whose line was reconciled: skipped, saying why", rows.length === 1 && /reconciled/.test(rows[0]!.skipped ?? "") && !rows[0]!.done, j(rows));
}

// The approval's own emails and notices finish in the background first.
await Bun.sleep(1500);
await mongoose.disconnect();
console.log(`\n${failures ? "\x1b[31m" : "\x1b[32m"}${checks - failures}/${checks} checks passed\x1b[0m`);
process.exit(failures ? 1 : 0);
