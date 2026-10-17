/**
 * GET /api/v1/service/finance-watch — the Root portal's Pending → Finance tab — over real HTTP against a real
 * finance API:
 *
 *   1. happy path   approvals waiting in every organization, how long each has waited, past 30 minutes delayed;
 *                   late entries waiting for a manager among them; entries typed with a date a day or more before
 *                   the day they were entered — invoice and bill payments, expenses, bills, invoices, cash lines —
 *                   with how they got in and the late-entry reason
 *   2. edge         same-day entries, decided approvals, ones entered over 30 days ago, matched and imported bank
 *                   lines left out; a payment an approval recorded, an HRMS expense, a CRM invoice marked as such
 *   3. errors       an organization with nothing: nothing for it, no failure
 *   4. permission   no secret, a wrong one
 *
 * Run through scripts/finance-watch-e2e.sh. Scratch database only.
 */
import mongoose, { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}

const { Organization } = await import("../modules/organization/organization.model");
const { Invoice } = await import("../modules/invoice/invoice.model");
const { Expense } = await import("../modules/expense/expense.model");
const { Bill } = await import("../modules/bill/bill.model");
const { BankTransaction } = await import("../modules/banking/bank-transaction.model");
const { LateEntryModel } = await import("../modules/late-entry/late-entry.model");

const API = `http://127.0.0.1:${process.env.E2E_API_PORT}/api/v1`;
const SECRET = process.env.E2E_ROOT_SECRET ?? "";

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const same = (label: string, got: unknown, want: unknown) => check(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
function step(s: string) { console.log(`\n\x1b[1m${s}\x1b[0m`); }
async function get(secret: string | null = SECRET) {
  const r = await fetch(`${API}/service/finance-watch`, { headers: secret === null ? {} : { "x-portal-secret": secret } });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
}

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
for (const c of await mongoose.connection.db!.listCollections().toArray()) await mongoose.connection.db!.collection(c.name).deleteMany({});

const now = Date.now();
const ago = (h: number) => new Date(now - h * 3_600_000);
const daysAgo = (d: number) => ago(d * 24);

step("Two organizations, waiting approvals, and entries typed late");
const hq = await Organization.create({ name: "Delta HQ E2E", baseCurrency: "AED" });
const blr = await Organization.create({ name: "Bangalore E2E", baseCurrency: "INR" });
await Organization.create({ name: "Empty E2E", baseCurrency: "AED" });

let seq = 0;
const raw = (model: { collection: { insertMany: (docs: any[]) => Promise<unknown> } }, docs: Record<string, unknown>[]) =>
  model.collection.insertMany(docs.map((d) => {
    const n = `E2E-${++seq}`;
    return { invoiceNumber: n, billNumber: n, expenseNumber: n, createdAt: new Date(now), updatedAt: new Date(now), currency: "AED", ...d };
  }));

// Waiting: an enrolment sent 2 hours ago (delayed), one 5 minutes ago (not yet); one decided (not waiting).
await raw(Invoice, [
  { organizationId: hq._id, invoiceNumber: "IN-WAIT-OLD", customerName: "Old Wait", issueDate: new Date(now), approval: { state: "pending", submittedAt: ago(2) }, createdAt: ago(2), totalMinor: 500000 },
  { organizationId: hq._id, invoiceNumber: "IN-WAIT-NEW", customerName: "New Wait", issueDate: new Date(now), approval: { state: "pending", submittedAt: new Date(now - 5 * 60_000) }, totalMinor: 300000 },
  { organizationId: hq._id, invoiceNumber: "IN-DONE", customerName: "Decided", issueDate: new Date(now), approval: { state: "approved", at: ago(1) }, totalMinor: 100000 },
  { organizationId: blr._id, invoiceNumber: "IN-BLR", customerName: "Blr Wait", issueDate: new Date(now), approval: { state: "pending", submittedAt: ago(3) }, currency: "INR", totalMinor: 9000000 },
]);
// A late entry waiting for a manager, raised an hour ago.
const lateId = new Types.ObjectId();
await LateEntryModel.collection.insertOne({
  _id: lateId, organizationId: hq._id, kind: "expense", refId: new Types.ObjectId(), number: "EXP-LATE", title: "Taxi", amountMinor: 4500, currency: "AED",
  date: daysAgo(12), reason: "Receipt found late", state: "pending", enteredById: new Types.ObjectId(), enteredByName: "Ellen Enterer", createdAt: ago(1), updatedAt: ago(1),
});

// Late typing.
const pid = () => new Types.ObjectId();
await raw(Invoice, [
  // Typed here, dated 10 days back.
  { organizationId: hq._id, invoiceNumber: "IN-TYPED", customerName: "Typed Old", issueDate: daysAgo(10), approval: { state: "not_required" }, totalMinor: 200000 },
  // From a CRM, dated 3 days back: marked as come in through approval.
  { organizationId: hq._id, invoiceNumber: "IN-CRM", customerName: "Crm Close", issueDate: daysAgo(3), external: { source: "delta-crm", externalId: "x1" },
    approval: { state: "approved", at: new Date(now) }, createdAt: new Date(now), totalMinor: 400000,
    payments: [
      { _id: pid(), method: "cash", amountMinor: 100000, paidOn: daysAgo(3), createdAt: new Date(now) },            // recorded by the approval
      { _id: pid(), method: "card", amountMinor: 50000, paidOn: daysAgo(5), createdAt: new Date(now - 3 * 3_600_000) }, // typed by an accountant later
    ] },
  // Payments on an invoice issued today: one typed 5 days back with a late entry, one from Tetra (externalRef), one same day.
  { organizationId: hq._id, invoiceNumber: "IN-PAY", customerName: "Pay Late", issueDate: new Date(now), approval: { state: "not_required" }, totalMinor: 300000,
    payments: [
      { _id: pid(), method: "bank_transfer", amountMinor: 120000, paidOn: daysAgo(9), createdAt: new Date(now), receiptNumber: "RCT-9",
        lateEntry: { state: "approved", entryId: pid(), reason: "Bank statement came late", enteredByName: "Abe Accountant", decidedByName: "Mo Manager" } },
      { _id: pid(), method: "card", amountMinor: 80000, paidOn: daysAgo(2), createdAt: new Date(now), externalRef: "tetra:123" },
      { _id: pid(), method: "cash", amountMinor: 10000, paidOn: new Date(now), createdAt: new Date(now) },
    ] },
  // Entered 40 days ago with an old date: outside the 30 days.
  { organizationId: hq._id, invoiceNumber: "IN-ANCIENT", customerName: "Ancient", issueDate: daysAgo(60), createdAt: daysAgo(40), approval: { state: "not_required" }, totalMinor: 1 },
]);
await raw(Expense, [
  { organizationId: hq._id, expenseNumber: "EXP-2D", description: "Fuel", categoryName: "Travel", expenseDate: daysAgo(2), submittedByName: "Sara Submitter", totalMinor: 9000, status: "approved",
    lateEntry: { state: "pending", entryId: pid(), reason: "Was travelling", enteredByName: "Sara Submitter" } },
  { organizationId: hq._id, expenseNumber: "EXP-HRMS", description: "Chairs", expenseDate: daysAgo(4), submittedByName: "HRMS", totalMinor: 70000, status: "approved", source: { kind: "hrms_procurement", key: "k1" } },
  { organizationId: hq._id, expenseNumber: "EXP-TODAY", description: "Lunch", expenseDate: new Date(now), submittedByName: "Sara", totalMinor: 1000, status: "approved" },
]);
await raw(Bill, [
  { organizationId: blr._id, billNumber: "BILL-8D", vendorName: "Office Rent", billDate: daysAgo(8), currency: "INR", totalMinor: 5000000, status: "open",
    payments: [{ _id: pid(), method: "bank_transfer", amountMinor: 2500000, paidOn: daysAgo(3), createdAt: new Date(now) }] },
]);
const acct = new Types.ObjectId();
const line = (o: Record<string, unknown>) => ({ organizationId: hq._id, accountId: acct, accountName: "Petty cash", currency: "AED", description: "Stationery",
  reference: "PC-1", amountMinor: 2500, type: "debit", runningBalanceMinor: 0, source: "manual", status: "unmatched", matches: [], createdAt: new Date(now), updatedAt: new Date(now), ...o });
await BankTransaction.collection.insertMany([
  line({ date: daysAgo(6) }),                                                                                              // typed, 6 days back
  line({ date: daysAgo(6), description: "Auto from a payment", status: "matched", matches: [{ type: "invoice", referenceId: "x", referenceNumber: "IN-1", amountMinor: 2500 }] }), // a payment's own line
  line({ date: daysAgo(6), description: "Imported", source: "import" }),                                                   // a statement import
]);

step("Case 4 — permission");
same("no secret: 401", (await get(null)).status, 401);
same("a wrong secret: 401", (await get("x".repeat(SECRET.length))).status, 401);

step("Case 1 — happy path: approvals waiting, delayed ones, entries typed late");
const r = await get();
same("200", r.status, 200);
const d = r.body?.data ?? {};
const ap = d.approvals ?? {};
const row = (id: string) => (ap.rows ?? []).find((x: any) => x.title?.includes(id) || x.id === id);
same("waiting: 3 enrolments (2 HQ, 1 Bangalore) + 1 late entry", ap.total, 4);
same("delayed (over 30 minutes): the 2-hour one, Bangalore's 3-hour one, the late entry an hour old", ap.delayed, 3);
const old = (ap.rows ?? []).find((x: any) => /Old Wait/.test(`${x.title} ${x.subtitle}`));
check("each says how long it has waited, its organization and kind", !!old && old.waitingMinutes >= 119 && old.delayed === true && old.orgName === "Delta HQ E2E"
  && old.kind === "Enrolment invoices", JSON.stringify(old));
const fresh = (ap.rows ?? []).find((x: any) => /New Wait/.test(`${x.title} ${x.subtitle}`));
check("the 5-minute one is not delayed", !!fresh && fresh.delayed === false && fresh.waitingMinutes <= 6, JSON.stringify(fresh));
const late = row(String(lateId));
check("the late entry: who entered it, since when, delayed, to the Late entries page", !!late && late.type === "late_entry" && late.raisedBy === "Ellen Enterer"
  && late.delayed === true && late.href === "/late-entries", JSON.stringify(late));
check("longest waiting first", (ap.rows ?? []).every((x: any, i: number, a: any[]) => i === 0 || a[i - 1].waitingMinutes >= x.waitingMinutes));
same("by kind: enrolments 3 (2 delayed), late entries 1 (1 delayed)", (ap.byKind ?? []).map((k: any) => [k.type, k.total, k.delayed]), [["invoice", 3, 2], ["late_entry", 1, 1]]);

const bd = d.backdated ?? {};
const entry = (num: string, kind?: string) => (bd.rows ?? []).find((x: any) => x.number === num && (!kind || x.kind === kind));
const typedInv = entry("IN-TYPED", "invoice");
check("an invoice typed here 10 days back", !!typedInv && typedInv.daysBack === 10 && typedInv.origin === "typed" && typedInv.amountMinor === 200000, JSON.stringify(typedInv));
const crmInv = entry("IN-CRM", "invoice");
check("a CRM's invoice dated 3 days back: came in through an approval", !!crmInv && crmInv.daysBack === 3 && crmInv.origin === "approval", JSON.stringify(crmInv));
const crmPays = (bd.rows ?? []).filter((x: any) => x.kind === "payment" && x.title?.includes("IN-CRM"));
same("its payments: the one the approval recorded, and the one typed later", crmPays.map((x: any) => [x.daysBack, x.origin]).sort(), [[3, "approval"], [5, "typed"]]);
const latePay = entry("RCT-9", "payment");
check("a payment typed 9 days back, with its late-entry reason, enterer and manager", !!latePay && latePay.daysBack === 9 && latePay.enteredBy === "Abe Accountant"
  && latePay.late?.state === "approved" && latePay.late?.reason === "Bank statement came late" && latePay.late?.decidedBy === "Mo Manager", JSON.stringify(latePay));
const tetraPay = (bd.rows ?? []).find((x: any) => x.kind === "payment" && x.title?.includes("IN-PAY") && x.daysBack === 2);
check("Tetra Commission's payment: recorded by its approval", tetraPay?.origin === "approval", JSON.stringify(tetraPay));
const exp = entry("EXP-2D", "expense");
check("an expense 2 days back, its submitter, its late entry waiting", !!exp && exp.daysBack === 2 && exp.enteredBy === "Sara Submitter" && exp.late?.state === "pending"
  && exp.title === "Travel · Fuel", JSON.stringify(exp));
check("an HRMS purchase as an expense: from HRMS", entry("EXP-HRMS", "expense")?.origin === "hrms");
const bill = entry("BILL-8D", "bill"), billPay = entry("BILL-8D", "bill_payment");
check("a Bangalore bill 8 days back and its payment 3 days back", bill?.daysBack === 8 && billPay?.daysBack === 3 && bill?.orgName === "Bangalore E2E" && bill?.currency === "INR",
  JSON.stringify([bill, billPay]));
const cash = (bd.rows ?? []).filter((x: any) => x.kind === "bank_line");
check("one petty cash line typed 6 days back, money out shown as minus", cash.length === 1 && cash[0].daysBack === 6 && cash[0].amountMinor === -2500, JSON.stringify(cash));
same("totals: 11 entries, 7 typed here, 1 late entry waiting", [bd.total, bd.typed, bd.lateWaiting], [11, 7, 1]);

step("Case 2 — edge: what is left out");
check("same-day entries left out (today's expense and cash payment)", !entry("EXP-TODAY") && !(bd.rows ?? []).some((x: any) => x.title?.includes("IN-PAY") && x.daysBack === 0));
check("entered over 30 days ago: left out", !entry("IN-ANCIENT"));
check("a payment's own bank line and a statement import: left out", !cash.some((x: any) => /Auto|Imported/.test(x.title)));
check("decided approvals are not waiting", !(ap.rows ?? []).some((x: any) => /Decided/.test(`${x.title} ${x.subtitle}`)));
same("the rules come with it", d.rules, { delayMinutes: 30, backdateMinDays: 1, enteredWithinDays: 30 });

step("Case 3 — an organization with nothing");
check("listed, nothing of its own, no failure", (d.organizations ?? []).some((o: any) => o.name === "Empty E2E")
  && !(ap.rows ?? []).some((x: any) => x.orgName === "Empty E2E") && (ap.unavailable ?? []).length === 0, JSON.stringify(ap.unavailable));

await mongoose.disconnect();
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
