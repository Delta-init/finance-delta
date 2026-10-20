/**
 * Late entries (the user, 2026-10-17: "when any old expense is entered a request goes to the managers … only
 * Manager-tagged users see the page, only they approve or reject … a reason has to be entered") — finance's services in
 * this process, on a scratch database. Today is fixed by the dates used: "old" is 10 days back, "recent" 2 days back.
 *
 *   1. The Manager tag on a person; the organization's days (7, 0 turns it off).
 *   2. An expense: recent — nothing asked; old without a reason — refused; with one — waiting, the managers emailed.
 *      Waiting: not approved, not paid. Approved by a manager — not by the one who typed it, not by a non-manager —
 *      then it pays, into its account. A new one rejected: rejected, and can't be sent again.
 *   3. An edit that moves an expense's date back: waiting; rejected — its date put back. Moved back within the days —
 *      no longer asked. Deleted while waiting — withdrawn.
 *   4. A bill: waiting — not approved, not paid; approved — paid. A new one rejected — voided.
 *   5. A bill payment: waiting — out of its account; approved — in. Rejected — removed, the bill owed again.
 *   6. An invoice payment: the same; an edit moving one back, rejected — its date and its line back.
 *   7. Entries finance makes itself (no one typing) are not asked; with days 0 nothing is.
 *   8. Super admins decide when nobody is tagged; the page answers who is a manager and how many wait.
 *
 * Run through scripts/late-entry-e2e.sh. Scratch databases only.
 */
import mongoose, { Types } from "mongoose";
import { isLateDate, lateEntryCutoff } from "@delta/shared";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}

const { Organization } = await import("../modules/organization/organization.model");
const { User } = await import("../modules/user/user.model");
const { Role } = await import("../modules/role/role.model");
const { Invoice } = await import("../modules/invoice/invoice.model");
const { Expense } = await import("../modules/expense/expense.model");
const { Bill } = await import("../modules/bill/bill.model");
const { Vendor } = await import("../modules/vendor/vendor.model");
const { BankTransaction } = await import("../modules/banking/bank-transaction.model");
const { EmailLog } = await import("../modules/email-log/email-log.model");
const { LateEntryModel } = await import("../modules/late-entry/late-entry.model");
const { createBankAccount } = await import("../modules/banking/banking.service");
const { updateOrganization, getOrganization } = await import("../modules/organization/organization.service") as any;
const users = await import("../modules/user/user.service");
const ex = await import("../modules/expense/expense.service");
const bills = await import("../modules/bill/bill.service");
const inv = await import("../modules/invoice/invoice.service");
const late = await import("../modules/late-entry/late-entry.service");
const { findOrCreateCustomer } = await import("../modules/customer/customer.service");

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
const back = (days: number) => lateEntryCutoff(days);   // that many days back, Dubai
const OLD = back(10), RECENT = back(2), OLDER = back(20);

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();

/* ── 0 ── */
step("0. The rule itself (shared)");
check("7 days: 7 back is not late, 8 back is", !isLateDate(back(7), 7) && isLateDate(back(8), 7));
check("today and the future are never late", !isLateDate(back(0), 7) && !isLateDate("2999-01-01", 7));
check("0 days turns it off", !isLateDate(OLDER, 0));

const org = await Organization.create({ name: "Delta HQ E2E", baseCurrency: "AED" });
const ORG = String(org._id);
const role = await Role.create({ organizationId: org._id, key: "accountant", name: "Accountant", permissions: ["expense:approve"] });
const person = (name: string, extra: Record<string, unknown> = {}) => User.create({
  name, email: `${name.toLowerCase().replace(/\s/g, ".")}@e2e-late.test`, passwordHash: "x", status: "active",
  memberships: [{ organizationId: org._id, roleId: role._id, status: "active", ...extra }],
});
const asha = await person("Asha Accountant");          // types things in
const mona = await person("Mona Manager");
const omar = await person("Omar Other");               // not a manager
const ASHA = String(asha._id), MONA = String(mona._id), OMAR = String(omar._id);
const typing = (reason?: string) => ({ userId: ASHA, reason });
const bank = await createBankAccount(ORG, { accountName: "Delta Bank", currency: "AED", accountType: "current", openingBalanceMinor: 0, openingDate: "2026-01-01" } as never);
await updateOrganization(ORG, { paymentAccounts: { bank_transfer: bank.id, tabby: bank.id } });
const linesFor = (refId: string) => BankTransaction.countDocuments({ "matches.referenceId": refId });

/* ── 1 ── */
step("1. The Manager tag; the organization's days");
const tagged = await users.updateUser(ORG, MONA, { isManager: true }, { userId: ASHA, isSuperAdmin: false });
check("Mona tagged Manager — the user says so", tagged.isManager === true, j(tagged));
const listed = await users.listUsers(ORG, { page: 1, pageSize: 50 } as never);
check("…and in the list; the others are not", listed.data.find((u) => u.id === MONA)?.isManager === true && listed.data.find((u) => u.id === OMAR)?.isManager === false);
check("the organization's days: 7 unless set", (await getOrganization(ORG)).lateEntryDays === 7);
check("Mona is a manager, Omar is not", (await late.isManager(ORG, MONA)) && !(await late.isManager(ORG, OMAR)));

const expense = (date: string, reason?: string, over: Record<string, unknown> = {}) => ex.createExpense(ORG, ASHA, {
  category: "other", description: "Taxi", expenseDate: date, amountMinor: 10_000, currency: "AED", categoryOther: "", taxPct: 0,
  taxInclusive: false, paymentAccount: "", reference: "", requiresApproval: false, isRecurring: false, paymentMethod: "bank_transfer", ...over,
} as never, typing(reason));
const entryFor = (refId: string) => LateEntryModel.findOne({ refId: new Types.ObjectId(refId) }).sort({ createdAt: -1 }).lean<any>();

/* ── 2 ── */
step("2. An expense typed in late");
const fresh = await expense(RECENT);
check("2 days back: nothing asked", !fresh.lateEntry && (await LateEntryModel.countDocuments({})) === 0);
check("10 days back with no reason: refused, saying why", /more than 7 days back — give the reason/.test(await refusal(expense(OLD))));
let e1 = await expense(OLD, "Receipt found in the car");
check("with a reason: waiting for a manager, the reason on it", e1.lateEntry?.state === "pending" && e1.lateEntry.reason === "Receipt found in the car" && e1.lateEntry.enteredByName === "Asha Accountant", j(e1.lateEntry));
let le1 = await entryFor(e1.id);
check("…a request on the page: who, why, how much", le1?.state === "pending" && le1.kind === "expense" && le1.number === e1.expenseNumber && le1.amountMinor === 10_000 && !le1.previousDate, j(le1));
await Bun.sleep(150);
const mail = await EmailLog.findOne({ kind: "late_entry" }).lean<any>();
check("the managers are emailed (Mona — not Asha, not Omar)", mail?.to?.includes("mona.manager@e2e-late.test") && !mail.to.includes("asha.accountant@e2e-late.test") && !mail.to.includes("omar.other@e2e-late.test"), j(mail?.to));
check("waiting: it can't be marked paid", /waiting for a manager/.test(await refusal(ex.markExpensePaid(ORG, e1.id, { paidOn: RECENT } as never))));
const e1b = await expense(OLD, "Late receipt", { requiresApproval: true });
check("…nor approved as a claim", /waiting for a manager/.test(await refusal(ex.approveExpense(ORG, e1b.id, OMAR, "Omar"))));
check("Omar (not a manager, no expense or bill access) can't see the page", /see expenses or bills/.test(await refusal(late.listLateEntries(ORG, OMAR, { state: "pending" }))));
check("…nor decide", /tagged Manager/.test(await refusal(late.decideLateEntry(ORG, OMAR, String(le1._id), "approved", ""))));
check("Mona sees both waiting, oldest first", (await late.listLateEntries(ORG, MONA, { state: "pending" })).map((x) => x.refId).join() === [e1.id, e1b.id].join());
await users.updateUser(ORG, ASHA, { isManager: true }, { userId: MONA, isSuperAdmin: false });
const mine = (await late.listLateEntries(ORG, ASHA, { state: "pending" })).find((x) => x.refId === e1.id);
check("Asha, tagged too, sees her own — but can't decide it", mine?.canDecide === false && /Somebody else decides your own/.test(await refusal(late.decideLateEntry(ORG, ASHA, String(le1._id), "approved", ""))));
await users.updateUser(ORG, ASHA, { isManager: false }, { userId: MONA, isSuperAdmin: false });
check("rejecting needs a reason", /Say why/.test(await refusal(late.decideLateEntry(ORG, MONA, String(le1._id), "rejected", ""))));
const ok1 = await late.decideLateEntry(ORG, MONA, String(le1._id), "approved", "Fine");
e1 = await ex.getExpense(ORG, e1.id, ALL);
check("Mona approves: the request and the expense say so", ok1.state === "approved" && ok1.decidedByName === "Mona Manager" && e1.lateEntry?.state === "approved" && e1.lateEntry.decidedByName === "Mona Manager", j(e1.lateEntry));
check("…twice is refused", /approved already/.test(await refusal(late.decideLateEntry(ORG, MONA, String(le1._id), "approved", ""))));
e1 = await ex.markExpensePaid(ORG, e1.id, { paidOn: RECENT } as never);
check("…now it pays, into its account", !!e1.paidOn && (await linesFor(e1.id)) === 1);
await Bun.sleep(150);
check("Asha is told", (await EmailLog.countDocuments({ kind: "late_entry", to: "asha.accountant@e2e-late.test" })) === 1);
const le1b = await entryFor(e1b.id);
await late.decideLateEntry(ORG, MONA, String(le1b._id), "rejected", "No receipt attached");
const r1 = await ex.getExpense(ORG, e1b.id, ALL);
check("a new one rejected: the expense is rejected, with the manager's reason", r1.status === "rejected" && /rejected by Mona Manager: No receipt attached/.test(r1.rejectedReason ?? "") && r1.lateEntry?.state === "rejected", j(r1));
check("…and can't be sent again as it is", /rejected it being entered late/.test(await refusal(ex.submitExpense(ORG, e1b.id, ALL))));

/* ── 3 ── */
step("3. An expense's date moved back");
let e2 = await expense(RECENT);
check("moved 10 days back with no reason: refused", /give the reason/.test(await refusal(ex.updateExpense(ORG, e2.id, { expenseDate: OLD } as never, ALL, typing()))));
e2 = await ex.updateExpense(ORG, e2.id, { expenseDate: OLD, lateReason: "Wrong date first" } as never, ALL, typing("Wrong date first"));
const le2 = await entryFor(e2.id);
check("with one: waiting, the date it had kept", e2.lateEntry?.state === "pending" && le2?.previousDate?.toISOString().slice(0, 10) === RECENT, j(le2));
e2 = await ex.updateExpense(ORG, e2.id, { description: "Taxi to the airport" } as never, ALL, typing());
check("another field edited: nothing more asked", e2.lateEntry?.state === "pending" && (await LateEntryModel.countDocuments({ refId: new Types.ObjectId(e2.id) })) === 1);
await late.decideLateEntry(ORG, MONA, String(le2._id), "rejected", "Keep the original date");
e2 = await ex.getExpense(ORG, e2.id, ALL);
check("rejected: its date is put back, the expense stands", e2.expenseDate === RECENT && e2.status === "approved" && e2.lateEntry?.state === "rejected", j(e2));
let e3 = await expense(OLD, "Forgot");
e3 = await ex.updateExpense(ORG, e3.id, { expenseDate: RECENT } as never, ALL, typing());
check("moved back within the days while waiting: no longer asked", !e3.lateEntry && (await entryFor(e3.id))?.state === "withdrawn", j(await entryFor(e3.id)));
const e4 = await expense(OLD, "Forgot");
await ex.deleteExpense(ORG, e4.id);
check("deleted while waiting: withdrawn", (await entryFor(e4.id))?.state === "withdrawn");
const e5 = await expense(OLD, "Forgot");
await Expense.deleteOne({ _id: e5.id });
const pageNow = await late.listLateEntries(ORG, MONA, { state: "pending" });
check("gone some other way: the page drops it", !pageNow.some((x) => x.refId === e5.id) && (await entryFor(e5.id))?.state === "withdrawn");

/* ── 4 ── */
step("4. A bill");
const vendor = await Vendor.create({ organizationId: org._id, vendorCode: "VEN-00001", name: "Gulf Supplies", email: "v@e2e-late.test", phone: "+971400000000", currency: "AED", status: "active" });
const bill = (date: string, reason?: string, over: Record<string, unknown> = {}) => bills.createBill(ORG, { vendorId: String(vendor._id), billDate: date, dueDate: RECENT, currency: "AED",
  lineItems: [{ description: "Paper", quantity: 1, unitPriceMinor: 50_000, discountPct: 0, taxPct: 0 }], notes: "", paymentTerms: "", requiresApproval: false, ...over } as never, typing(reason));
const pay = (id: string, date: string, reason?: string, over: Record<string, unknown> = {}) => bills.recordBillPayment(ORG, id, { method: "bank_transfer", amountMinor: 20_000, paidOn: date, reference: "", accountName: "", notes: "", chargesMinor: 0, ...over } as never, typing(reason));
check("10 days back with no reason: refused", /give the reason/.test(await refusal(bill(OLD))));
let b1 = await bill(OLD, "Invoice came by post");
check("with one: waiting", b1.lateEntry?.state === "pending");
check("waiting: it can't be paid", /waiting for a manager/.test(await refusal(pay(b1.id, RECENT))));
const b1a = await bill(OLD, "Late", { requiresApproval: true });
check("…nor approved", /waiting for a manager/.test(await refusal(bills.approveBill(ORG, b1a.id))));
await late.decideLateEntry(ORG, MONA, String((await entryFor(b1.id))._id), "approved", "");
b1 = await pay(b1.id, RECENT);
check("approved: it is paid", b1.payments.length === 1 && b1.lateEntry?.state === "approved");
const b2 = await bill(OLD, "Duplicate?");
await late.decideLateEntry(ORG, MONA, String((await entryFor(b2.id))._id), "rejected", "Already entered as BILL-00001");
check("a new one rejected: voided", (await bills.getBill(ORG, b2.id)).status === "voided");

/* ── 5 ── */
step("5. A bill payment");
let b3 = await bill(RECENT);
b3 = await pay(b3.id, OLD, "Paid last week, slip found today");
let p3 = b3.payments[0]!;
check("10 days back: waiting, out of its account", p3.lateEntry?.state === "pending" && p3.bankAccountId === bank.id && (await linesFor(b3.id)) === 0, j(p3));
await late.decideLateEntry(ORG, MONA, String((await entryFor(b3.id))._id), "approved", "");
check("approved: in its account", (await linesFor(b3.id)) === 1 && (await bills.getBill(ORG, b3.id)).payments[0]!.lateEntry?.state === "approved");
b3 = await pay(b3.id, OLDER, "Another old one");
const p3b = b3.payments[1]!;
check("another, waiting; the bill counts it meanwhile", p3b.lateEntry?.state === "pending" && b3.amountPaidMinor === 40_000);
await late.decideLateEntry(ORG, MONA, String((await LateEntryModel.findOne({ paymentId: new Types.ObjectId(p3b.id) }).lean<any>())._id), "rejected", "Not ours");
b3 = await bills.getBill(ORG, b3.id);
check("rejected: removed, the bill owed again", b3.payments.length === 1 && b3.amountPaidMinor === 20_000 && b3.balanceMinor === 30_000, j({ n: b3.payments.length, paid: b3.amountPaidMinor }));

/* ── 6 ── */
step("6. An invoice payment");
const { customer } = await findOrCreateCustomer(ORG, { name: "Client One", email: "one@e2e-late.test", phone: "+971500000000" } as never);
const iv = await inv.createInvoice(ORG, { customerId: customer.id, salespersonId: ASHA, issueDate: RECENT, dueDate: RECENT, currency: "AED",
  reference: "E2E-1", notes: "", taxInclusive: true, lineItems: [{ description: "Course", quantity: 1, unitPriceMinor: 500_000, taxes: [] }] } as never, ALL as never);
await Invoice.updateOne({ _id: iv.id }, { $set: { status: "sent" } });
const ipay = (date: string, reason?: string) => inv.recordPayment(ORG, iv.id, { method: "tabby", amountMinor: 100_000, paidOn: date, reference: "", notes: "", accountName: "", chargesMinor: 0 } as never, undefined, undefined, typing(reason));
check("10 days back with no reason: refused", /give the reason/.test(await refusal(ipay(OLD))));
let d = await ipay(OLD, "Tabby settled late");
let ip = d.payments.at(-1)!;
check("with one: waiting, out of its account", ip.lateEntry?.state === "pending" && (await linesFor(iv.id)) === 0, j(ip));
await late.decideLateEntry(ORG, MONA, String((await LateEntryModel.findOne({ paymentId: new Types.ObjectId(ip.id) }).lean<any>())._id), "approved", "");
check("approved: in its account", (await linesFor(iv.id)) === 1);
d = await ipay(RECENT);
const ip2 = d.payments.at(-1)!;
check("2 days back: nothing asked, straight in", !ip2.lateEntry && (await linesFor(iv.id)) === 2);
d = await inv.updatePayment(ORG, iv.id, ip2.id, { method: "tabby", amountMinor: 100_000, paidOn: OLDER, reference: "", notes: "", accountName: "", chargesMinor: 0 } as never, typing("Typed the wrong date"));
check("edited 20 days back: waiting, out of its account again", d.payments.find((x) => x.id === ip2.id)?.lateEntry?.state === "pending" && (await linesFor(iv.id)) === 1);
await late.decideLateEntry(ORG, MONA, String((await LateEntryModel.findOne({ paymentId: new Types.ObjectId(ip2.id), state: "pending" }).lean<any>())._id), "rejected", "Date was right");
let ivNow = await inv.getInvoice(ORG, iv.id, ALL as never);
check("rejected: its date and its line back", ivNow.payments.find((x) => x.id === ip2.id)?.paidOn === RECENT && (await linesFor(iv.id)) === 2, j(ivNow.payments.find((x) => x.id === ip2.id)));
d = await ipay(OLD, "Cash found");
const ip3 = d.payments.at(-1)!;
await late.decideLateEntry(ORG, MONA, String((await LateEntryModel.findOne({ paymentId: new Types.ObjectId(ip3.id) }).lean<any>())._id), "rejected", "Not received");
ivNow = await inv.getInvoice(ORG, iv.id, ALL as never);
check("a new one rejected: removed, the invoice owed again", !ivNow.payments.some((x) => x.id === ip3.id) && ivNow.amountPaidMinor === 200_000, String(ivNow.amountPaidMinor));

/* ── 7 ── */
step("7. Not asked");
const before = await LateEntryModel.countDocuments({});
await inv.recordPayment(ORG, iv.id, { method: "tabby", amountMinor: 10_000, paidOn: OLDER, reference: "", notes: "", accountName: "", chargesMinor: 0 } as never);
check("finance recording a payment itself (an approval, Tetra Commission): nothing asked", (await LateEntryModel.countDocuments({})) === before);
await updateOrganization(ORG, { lateEntryDays: 0 });
const off = await expense(OLDER);
check("days 0: nothing is asked", !off.lateEntry && (await LateEntryModel.countDocuments({})) === before);
await updateOrganization(ORG, { lateEntryDays: 7 });

/* ── 8 ── */
step("8. Nobody tagged; the reader");
await users.updateUser(ORG, MONA, { isManager: false }, { userId: ASHA, isSuperAdmin: false });
const root = await User.create({ name: "Root Admin", email: "root@e2e-late.test", passwordHash: "x", status: "active", isSuperAdmin: true, memberships: [] });
const e6 = await expense(OLD, "Quarter end");
await Bun.sleep(150);
const m6 = await EmailLog.findOne({ kind: "late_entry", "ref.id": new Types.ObjectId(e6.id) }).lean<any>();
check("nobody tagged: the super admins are emailed", m6?.to?.includes("root@e2e-late.test"), j(m6?.to));
const me = await late.lateEntryMe(ORG, String(root._id));
check("a super admin is a manager here, and sees what waits", me.isManager && me.pending >= 1 && me.days === 7, j(me));
const omarMe = await late.lateEntryMe(ORG, OMAR);
check("Omar: not a manager, can't read them, nothing counted — and told who decides (the super admins, nobody tagged)",
  !omarMe.isManager && omarMe.pending === 0 && omarMe.days === 7 && omarMe.canView === false && omarMe.scope === "none" && omarMe.managers?.join() === "Root Admin", j(omarMe));
await late.decideLateEntry(ORG, String(root._id), String((await entryFor(e6.id))._id), "approved", "");
check("…and decides", (await ex.getExpense(ORG, e6.id, ALL)).lateEntry?.state === "approved");
const decided = await late.listLateEntries(ORG, String(root._id), { state: "decided" });
check("decided ones listed, newest first, with who decided", decided[0]?.refId === e6.id && decided[0]?.decidedByName === "Root Admin" && decided.some((x) => x.state === "rejected"), j(decided[0]));

/* ── 9 ── */
step("9. Who reads them (2026-10-20): expense or bill access reads all, own-expense access reads their own");
const OTHER_REF = new Types.ObjectId();
await LateEntryModel.collection.insertOne({
  organizationId: new Types.ObjectId(ORG), kind: "expense", refId: OTHER_REF, number: "EXP-OMAR", title: "Omar's taxi", amountMinor: 5_000,
  currency: "AED", date: new Date(OLD), reason: "Forgot", state: "approved", enteredById: new Types.ObjectId(OMAR), enteredByName: "Omar Other",
  decidedByName: "Root Admin", decidedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
});
const e9 = await expense(OLD, "Another late one");
const reader = await late.lateEntryMe(ORG, OMAR, ["expense:read"]);
check("Omar with expense:read: reads them all, isn't a manager, counts what waits", reader.canView === true && reader.scope === "all" && !reader.isManager && reader.pending >= 1, j(reader));
const allRows = await late.listLateEntries(ORG, OMAR, { state: "all" }, ["expense:read"]);
check("…All: waiting and decided together, his own and Asha's", allRows.some((x) => x.state === "pending" && x.refId === e9.id) && allRows.some((x) => x.number === "EXP-OMAR") && allRows.some((x) => x.state === "approved" && x.refId !== String(OTHER_REF)), j(allRows.map((x) => [x.number, x.state])));
check("…never a button: he can't decide", allRows.every((x) => !x.canDecide) && /tagged Manager/.test(await refusal(late.decideLateEntry(ORG, OMAR, String((await entryFor(e9.id))._id), "approved", ""))));
check("bill:read reads them too", (await late.lateEntryMe(ORG, OMAR, ["bill:read"])).scope === "all");
const own = await late.listLateEntries(ORG, OMAR, { state: "all" }, ["expense:read:own"]);
check("Omar with only his own expenses: only his own", own.length === 1 && own[0]?.number === "EXP-OMAR", j(own.map((x) => x.number)));
const ownMe = await late.lateEntryMe(ORG, OMAR, ["expense:write:own"]);
check("…/me says own, counting only his own waiting (none)", ownMe.scope === "own" && ownMe.canView === true && ownMe.pending === 0, j(ownMe));
const waitingNow = await late.listLateEntries(ORG, String(root._id), { state: "pending" });
check("a manager still decides them, and sees the buttons", waitingNow.some((x) => x.refId === e9.id && x.canDecide), j(waitingNow.map((x) => [x.number, x.canDecide])));

console.log(`\n${checks - failures}/${checks} passed`);
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
