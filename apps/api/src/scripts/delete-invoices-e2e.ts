/**
 * scripts/delete-invoices.ts against a scratch database (the user, 2026-10-22: "delete those invoices, their payment
 * history also"):
 *   - the plan lists each invoice's payments (with their bank lines), commission records, LMS provisioning, reminders;
 *   - deleting takes the payments (their bank lines, the account's balance back), the commission, the pending LMS
 *     provisioning and reminders, then the invoice — after a backup that reads back whole;
 *   - a commission already paid out, a number in two organizations, or one that is not there: refused, nothing deleted;
 *   - --undo puts it all back, balances included.
 *
 * Run through scripts/delete-invoices-e2e.sh (throwaway mongod, no .env anywhere).
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
const { BankTransaction } = await import("../modules/banking/bank-transaction.model");
const { CommissionRecord } = await import("../modules/commission/commission-record.model");
const { LmsProvision } = await import("../modules/integrations/lms-provision.model");
const { InstalmentReminder } = await import("../modules/invoice/instalment-reminder.model");
const { createBankAccount, getBankAccount } = await import("../modules/banking/banking.service");
const { updateOrganization } = await import("../modules/organization/organization.service") as any;
const { findOrCreateCustomer } = await import("../modules/customer/customer.service");
const inv = await import("../modules/invoice/invoice.service");
const del = await import("./delete-invoices");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const j = (v: unknown) => String(JSON.stringify(v)).slice(0, 500);

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();

const org = await Organization.create({ name: "Delta HQ E2E", baseCurrency: "AED", lateEntryDays: 0 });
const ORG = String(org._id);
const other = await Organization.create({ name: "Other E2E", baseCurrency: "AED", lateEntryDays: 0 });
const sp = await User.create({ name: "Sam Sales", email: "sam@e2e-del.test", passwordHash: "x", status: "active", memberships: [{ organizationId: org._id, roleId: new Types.ObjectId(), status: "active" }] });
const bank = await createBankAccount(ORG, { accountName: "Delta Bank", currency: "AED", accountType: "current", openingBalanceMinor: 1_000_000, openingDate: "2026-01-01" } as never);
await updateOrganization(ORG, { paymentAccounts: { bank_transfer: bank.id, cash: bank.id } });
const balance = async () => (await getBankAccount(ORG, bank.id)).currentBalanceMinor;
const { customer } = await findOrCreateCustomer(ORG, { name: "Abshar ttpp", email: "abshar@e2e-del.test", phone: "+971500000001" } as never);
const ALL = { all: true } as const;
const make = async (total: number) => {
  const iv = await inv.createInvoice(ORG, { customerId: customer.id, salespersonId: String(sp._id), issueDate: "2026-10-03", dueDate: "2026-10-03", currency: "AED",
    reference: "", notes: "", taxInclusive: true, lineItems: [{ description: "Course", quantity: 1, unitPriceMinor: total, taxes: [] }] } as never, ALL as never);
  await Invoice.updateOne({ _id: iv.id }, { $set: { status: "sent" } });
  return iv;
};
const pay = (id: string, amount: number, method: string) => inv.recordPayment(ORG, id, { method, amountMinor: amount, paidOn: "2026-10-05", reference: "", notes: "", accountName: "", chargesMinor: 0 } as never);

const a = await make(225_000);
await pay(a.id, 100_000, "cash");
await pay(a.id, 5_000, "bank_transfer");
const aNumber = (await Invoice.findById(a.id).lean<any>()).invoiceNumber;
await CommissionRecord.create({ organizationId: org._id, structureId: new Types.ObjectId(), salespersonId: sp._id, salespersonName: "Sam Sales", invoiceId: a.id,
  invoiceNumber: aNumber, invoiceTotalMinor: 225_000, commissionMinor: 11_250, basis: "payment_received", status: "earned" });
await LmsProvision.collection.insertOne({ organizationId: org._id, invoiceId: new Types.ObjectId(a.id), invoiceNumber: aNumber, payload: {}, status: "pending", createdAt: new Date(), updatedAt: new Date() });
await InstalmentReminder.collection.insertOne({ organizationId: org._id, invoiceId: new Types.ObjectId(a.id), stage: "due", sendAt: new Date(), createdAt: new Date() });
const b = await make(1_000);
await pay(b.id, 1_000, "cash");
const bNumber = (await Invoice.findById(b.id).lean<any>()).invoiceNumber;
const c = await make(50_000);
const cNumber = (await Invoice.findById(c.id).lean<any>()).invoiceNumber;
await CommissionRecord.create({ organizationId: org._id, structureId: new Types.ObjectId(), salespersonId: sp._id, salespersonName: "Sam Sales", invoiceId: c.id,
  invoiceNumber: cNumber, invoiceTotalMinor: 50_000, commissionMinor: 2_500, basis: "invoice_raised", status: "paid" });
await Invoice.collection.insertOne({ organizationId: other._id, invoiceNumber: bNumber, customerName: "Elsewhere", status: "draft", totalMinor: 1, payments: [] });

const before = await balance();
check("set up: 3 payments in the bank (1,060 in)", before === 1_000_000 + 106_000, String(before));

/* ── 1 ── */
step("1. What it would delete");
let plan = await del.planDelete([aNumber], ORG);
const pa = plan.invoices[0]!;
check("no problems; the invoice, its 2 payments with their bank lines", !plan.problems.length && pa.payments.length === 2 && pa.payments.every((p) => p.includes("line in Delta Bank")), j(plan));
check("…its commission record, its pending LMS provisioning (removed), 1 reminder", pa.commissions.length === 1 && /pending — removed/.test(pa.lms) && pa.reminders === 1, j(pa));
check("nothing deleted by planning", !!(await Invoice.exists({ _id: a.id })) && (await balance()) === before);

/* ── 2 ── */
step("2. Refused");
plan = await del.planDelete([bNumber]);
check("a number in two organizations: asks for --org", plan.problems.some((p) => /2 organizations — say which with --org/.test(p)), j(plan.problems));
plan = await del.planDelete(["IN-99999"], ORG);
check("one that is not there: said", plan.problems.some((p) => /no such invoice/.test(p)), j(plan.problems));
const refused = await del.runDelete([aNumber, cNumber], { orgId: ORG, backupDir: os.tmpdir() });
check("a commission already paid out: refused — and nothing deleted, not even the other one",
  refused.problems.some((p) => /already paid out/.test(p)) && !refused.backup && !!(await Invoice.exists({ _id: a.id })) && (await balance()) === before, j(refused.problems));

await LmsProvision.collection.insertOne({ organizationId: org._id, invoiceId: new Types.ObjectId(c.id), invoiceNumber: cNumber, payload: {}, status: "sent", commission: { state: "sent" }, createdAt: new Date(), updatedAt: new Date() });
plan = await del.planDelete([cNumber], ORG);
check("one CS Portal has, where it cannot be told (no COMMISSION_API_URL here): refused, saying run it on the server",
  plan.problems.some((p) => /CS Portal has this enrolment.*run this on the server/.test(p)) && /LMS access stays/.test(plan.invoices[0]!.lms), j(plan));

/* ── 3 ── */
step("3. Deleted, payments first");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "del-inv-"));
const done = await del.runDelete([aNumber, bNumber], { orgId: ORG, backupDir: dir });
check("both deleted, a backup written", !done.problems.length && !!done.backup && fs.existsSync(done.backup!), j(done.problems));
check("the invoices are gone", !(await Invoice.exists({ _id: a.id })) && !(await Invoice.exists({ _id: b.id })));
check("their bank lines are gone, the balance back to before the payments", (await BankTransaction.countDocuments({ "matches.referenceId": { $in: [a.id, b.id] } })) === 0 && (await balance()) === 1_000_000, String(await balance()));
check("the commission, the pending LMS provisioning and the reminder are gone",
  !(await CommissionRecord.exists({ invoiceId: a.id })) && !(await LmsProvision.exists({ invoiceId: a.id })) && !(await InstalmentReminder.exists({ invoiceId: a.id })));
check("the other organization's invoice with the same number is untouched", !!(await Invoice.exists({ organizationId: other._id, invoiceNumber: bNumber })));

/* ── 4 ── */
step("4. Undo");
const dry = await del.undoDelete(done.backup!, false);
check("dry: says what it would put back, puts nothing", /2 invoice\(s\).*3 payment\(s\); 3 bank line\(s\); 1 commission record\(s\); 1 LMS provisioning; 1 reminder\(s\)/.test(dry[0]!) && !(await Invoice.exists({ _id: a.id })), j(dry));
await del.undoDelete(done.backup!, true);
const back = await inv.getInvoice(ORG, a.id, ALL as never);
check("the invoice is back with its 2 payments", back.payments.length === 2 && back.amountPaidMinor === 105_000, j({ n: back.payments.length, paid: back.amountPaidMinor }));
check("its bank lines are back, the balance with them", (await balance()) === before, String(await balance()));
check("its commission, LMS provisioning and reminder are back", !!(await CommissionRecord.exists({ invoiceId: a.id })) && !!(await LmsProvision.exists({ invoiceId: a.id })) && !!(await InstalmentReminder.exists({ invoiceId: a.id })));
const again = await del.undoDelete(done.backup!, true);
check("undo twice: nothing doubled", /0 invoice\(s\)/.test(again[0]!) && (await balance()) === before, j(again));

console.log(`\n${checks - failures}/${checks} passed`);
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
