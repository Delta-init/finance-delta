/**
 * The old books' invoices brought in (the user, 2026-10-21) — scripts/invoice-import.ts against a scratch database.
 *
 * What it proves:
 *   - a dry run writes nothing, and lists what finance already has — the same client and total within 10 days, or
 *     the same number — and finance's own invoices from the same months with no match;
 *   - written: each invoice with its number, dates, lines and VAT (the organization's 5% code, tax-inclusive), its total
 *     the old books', what was paid as one payment, paid / part-paid / overdue, created on its own date, history only
 *     (approval not required, external.source "old_books");
 *   - clients: finance's of that email reused, new ones made (one with no email gets an address that cannot receive
 *     mail); salespeople: the one finance user of that name, else one suspended "Old books" user;
 *   - an imported part-paid invoice is never reminded about, never in the "entered late" views; its income is in the
 *     P&L, and the Daily Report names it "Old books";
 *   - a second run adds nothing; the undo takes out the invoices, the clients it made and the user it made — a client
 *     finance already had stays.
 *
 * Run through scripts/invoice-import-e2e.sh (throwaway mongod, no .env anywhere).
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
const { Customer } = await import("../modules/customer/customer.model");
const { Invoice } = await import("../modules/invoice/invoice.model");
const reports = await import("../modules/reports/reports.service");
const { backdatedIn } = await import("../modules/integrations/portal-watch.service");
const { runInstalmentReminders } = await import("../jobs/instalment-reminder.worker");
const imp = await import("./invoice-import");

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

const org = await Organization.create({ name: "Delta HQ E2E", baseCurrency: "AED", lateEntryDays: 0,
  taxRates: [{ label: "VAT 5%", code: "VAT5", rate: 5, isDefault: true, appliesTo: "both" }] });
const ORG = String(org._id);
const roleId = new Types.ObjectId();
const user = (name: string) => User.create({ name, email: `${name.toLowerCase().replace(/\W/g, "")}-${Math.random().toString(36).slice(2, 6)}@e2e-inv.test`,
  passwordHash: "x", status: "active", memberships: [{ organizationId: org._id, roleId, status: "active" }] });
const riya = await user("Riya");
await user("Sana"); await user("Sana");              // two of them: no one can say which
const anas = await Customer.create({ organizationId: org._id, customerCode: "CUST-00001", name: "Anas K", email: "anas@x.test", phone: "+97150" });
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const own = (number: string, customerId: Types.ObjectId, name: string, date: string, totalMinor: number) => Invoice.create({
  organizationId: org._id, invoiceNumber: number, customerId, customerName: name, salespersonId: riya._id, salespersonName: "Riya",
  status: "paid", issueDate: new Date(`${date}T00:00:00Z`), dueDate: new Date(`${date}T00:00:00Z`), currency: "AED", totalMinor, balanceMinor: 0, amountPaidMinor: totalMinor,
});
await own("IN-00001", anas._id, "Anas K", "2026-09-10", 150_000);          // the same sale as DMDT006001 below
await own("DMDT000010", anas._id, "Anas K", "2026-09-02", 90_000);          // a number the old books also used
const bina = await Customer.create({ organizationId: org._id, customerCode: "CUST-00002", name: "Bina", email: "bina@x.test", phone: "+97151" });
await own("IN-00002", bina._id, "Bina", "2026-09-12", 99_900);              // only in finance

const line = (name: string, lineTotalMinor: number, taxPct = 5, quantity = 1) =>
  ({ name, desc: "", quantity, taxPct, lineTotalMinor, taxMinor: taxPct ? Math.round(lineTotalMinor - lineTotalMinor / 1.05) : 0 });
const inv = (n: number, over: Partial<import("./invoice-import").ImportInvoice>): import("./invoice-import").ImportInvoice => ({
  number: `DMDT00${6000 + n}`, zohoId: `Z${n}`, file: "e2e.xlsx", date: "2024-03-01", dueDate: "2024-03-01",
  customer: { zohoId: `C${n}`, name: `Client ${n}`, email: `client${n}@x.test`, phone: "+97155" }, salesperson: "riya", currency: "AED",
  subtotalMinor: 0, totalMinor: 150_000, balanceMinor: 0, paidMinor: 150_000, lastPaymentDate: "2024-03-02", status: "paid",
  notes: "Thanks for your business.", terms: "", reference: "", estimate: "", subject: "", lines: [line("Market Break-out Trading Program", 150_000)], ...over,
});
const data = { batch: "zoho-e2e", invoices: [
  inv(1, {}),                                                                                     // paid, Riya
  inv(2, { salesperson: "sana", totalMinor: 270_000, balanceMinor: 100_000, paidMinor: 170_000, status: "partial", dueDate: day(3),
    lines: [line("Delta Wave Theory Program", 210_000), line("PipsCraft Signal service", 60_000, 0)] }),   // part-paid, due in 3 days
  inv(3, { customer: { zohoId: "C3", name: "No Mail", email: "", phone: "" }, salesperson: "", totalMinor: 120_000, balanceMinor: 120_000, paidMinor: 0,
    lastPaymentDate: null, status: "overdue", lines: [line("Market Break-out Trading Program", 120_000)] }),                                                   // owing, no email, no salesperson
  inv(4, { totalMinor: 100_000, paidMinor: 100_000, lines: [line("Course seminars", 100_000, 5, 3)] }),          // 3 × not a whole fil
  inv(5, { customer: { zohoId: "C5", name: "Anas K", email: "anas@x.test", phone: "" }, date: "2025-06-01", totalMinor: 120_000, paidMinor: 120_000,
    lines: [line("Market Break-out Trading Program", 120_000)] }), // finance's client, reused
  inv(6, { customer: { zohoId: "C6", name: "Anas K", email: "anas@x.test", phone: "" }, date: "2026-09-14" }),  // = IN-00001
  { ...inv(7, { date: "2026-09-02", totalMinor: 90_000, paidMinor: 90_000 }), number: "DMDT000010" },             // finance has that number
] };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "invoice-import-e2e-"));
const file = path.join(dir, "data.json");
fs.writeFileSync(file, JSON.stringify(data));
const before = await Invoice.countDocuments();

/* ── 1 ── */
step("1. The dry run");
let plan = await imp.importInvoices({ file, orgId: ORG, write: false });
check("no problems", plan.problems.length === 0, j(plan.problems));
check("5 to import, 2 already in finance", plan.toImport.length === 5 && plan.inFinance.length === 1 && plan.sameNumber.length === 1, j([plan.toImport.length, plan.inFinance, plan.sameNumber]));
check("…the same sale: DMDT006006 = IN-00001 (same client, total, 4 days apart)", plan.inFinance[0]?.number === "DMDT006006" && plan.inFinance[0]?.matches.startsWith("IN-00001"), j(plan.inFinance));
check("…the same number: DMDT000010", plan.sameNumber[0]?.number === "DMDT000010", j(plan.sameNumber));
check("finance's own with no match in the old books: IN-00002", plan.onlyInFinance.length === 1 && plan.onlyInFinance[0]?.number === "IN-00002", j(plan.onlyInFinance));
check("clients: 1 reused (Anas), 4 to add (one with no email)", plan.customers.reused === 1 && plan.customers.toCreate === 4, j(plan.customers));
const to = Object.fromEntries(plan.salespeople.map((s) => [s.name, s.to]));
check("salespeople: riya → Riya; sana (two of them) and none → Old books", to.riya === "Riya" && to.sana === "Old books (imported)" && to["(none)"] === "Old books (imported)" && plan.placeholderToCreate, j(plan.salespeople));
check("10 changes (5 + 4 + 1 user), nothing written", imp.countOf(plan) === 10 && (await Invoice.countDocuments()) === before && !(await User.exists({ name: "Old books (imported)" })));

/* ── 2 ── */
step("2. Written");
plan = await imp.importInvoices({ file, orgId: ORG, write: true, backupDir: dir });
const rows = await Invoice.find({ "external.source": "old_books" }).sort({ invoiceNumber: 1 }).lean<any[]>();
check("5 imported, with a backup", rows.length === 5 && !!plan.backup && fs.existsSync(plan.backup!), String(rows.length));
const one = rows.find((r) => r.invoiceNumber === "DMDT006001")!;
check("history only: approval not required, the old books' id, created on its own date",
  one.approval?.state === "not_required" && one.external?.externalId === "Z1" && one.createdAt.toISOString().startsWith("2024-03-01"), j([one.approval, one.external, one.createdAt]));
check("paid: one payment, other, on the last payment date, no bank line",
  one.status === "paid" && one.payments.length === 1 && one.payments[0].method === "other" && one.payments[0].amountMinor === 150_000
  && one.payments[0].paidOn.toISOString().startsWith("2024-03-02") && !one.payments[0].bankAccountId, j(one.payments));
check("lines: tax-inclusive 5% under the organization's code — 1,428.57 + 71.43 = 1,500",
  one.taxInclusive && one.lineItems[0].taxes[0]?.code === "VAT5" && one.lineItems[0].taxableMinor === 142_857 && one.taxTotalMinor === 7_143 && one.totalMinor === 150_000, j(one.lineItems));
const two = rows.find((r) => r.invoiceNumber === "DMDT006002")!;
check("part-paid: 1,700 paid, 1,000 owed; the 0% line carries no VAT", two.status === "partial" && two.amountPaidMinor === 170_000 && two.balanceMinor === 100_000
  && two.lineItems[1].taxes.length === 0 && two.totalMinor === 270_000, j([two.status, two.amountPaidMinor, two.balanceMinor, two.lineItems]));
const three = rows.find((r) => r.invoiceNumber === "DMDT006003")!;
const noMail = await Customer.findById(three.customerId).lean<any>();
check("owing, no email: overdue, nothing paid, its client at an address that cannot receive mail", three.status === "overdue" && !three.payments.length
  && noMail?.email === "no-email-c3@old-books.invalid" && noMail?.phone === "-", j([three.status, noMail]));
const four = rows.find((r) => r.invoiceNumber === "DMDT006004")!;
check("3 × 333.33… : one line of 1,000 saying × 3", four.lineItems[0].quantity === 1 && four.lineItems[0].lineTotalMinor === 100_000 && /× 3/.test(four.lineItems[0].description), j(four.lineItems));
const five = rows.find((r) => r.invoiceNumber === "DMDT006005")!;
check("finance's own client reused", String(five.customerId) === String(anas._id));
const oldBooks = await User.findOne({ name: "Old books (imported)" }).lean<any>();
check("the Old books user: suspended, in no organization", oldBooks?.status === "suspended" && oldBooks?.memberships?.length === 0, j(oldBooks));
check("salespeople linked: Riya's to Riya, sana's and none to Old books, the old name kept",
  String(one.salespersonId) === String(riya._id) && String(two.salespersonId) === String(oldBooks?._id) && two.salespersonName === "sana" && three.salespersonName === "Old books", j([two.salespersonName, three.salespersonName]));
check("new clients numbered on from finance's own (CUST-00003…)", (await Customer.countDocuments({ customerCode: /^CUST-0000[3-6]$/ })) === 4);

/* ── 3 ── */
step("3. Never a reminder, never 'entered late'; in the reports");
const reminders = await runInstalmentReminders(new Date());
check("the part-paid one due in 3 days: no reminder", reminders.sent + reminders.failed + reminders.skipped === 0, j(reminders));
const late = await backdatedIn({ _id: org._id, name: org.name }, new Date(Date.now() - 1000 * 86_400_000));
check("not in the entered-late views (finance's own late ones are)", !late.some((r) => /^DMDT006/.test(String((r as { number?: string }).number ?? ""))) && late.some((r) => (r as { number?: string }).number === "IN-00001"), j(late.map((r) => (r as { number?: string }).number)));
const pl = await reports.getProfitLoss(ORG, "2024-01-01", "2024-12-31");
// 1,500 → 1,428.57; 2,100 → 2,000 + the 0% 600; 1,200 → 1,142.86; 1,000 → 952.38.
check("2024 income in the P&L: the four 2024 invoices, net of VAT", pl.income.total === 142_857 + 200_000 + 60_000 + 114_286 + 95_238, j(pl.income));
const income = await reports.getDailyBreakdown(ORG, "income", "2024-03-01", "2024-03-05");
check("the Daily Report names where it came from: Old books", income.groups.find((g) => g.key === "crm")?.items.some((i) => i.name === "Old books") === true, j(income.groups));

/* ── 4 ── */
step("4. Again, and the undo");
const again = await imp.importInvoices({ file, orgId: ORG, write: false });
check("a second run adds nothing: 5 imported before", imp.countOf(again) === 0 && again.already === 5, j([again.already, again.toImport.length]));
await imp.undoImport(plan.backup!, true);
check("the undo: the invoices out, finance's own stay", (await Invoice.countDocuments({ "external.source": "old_books" })) === 0 && (await Invoice.countDocuments()) === before);
check("…the clients it made out, Anas (finance's) stays", (await Customer.countDocuments()) === 2 && !!(await Customer.exists({ _id: anas._id })));
check("…the Old books user out", !(await User.exists({ name: "Old books (imported)" })));

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${failures ? "\x1b[31m" : "\x1b[32m"}${checks - failures}/${checks} passed\x1b[0m`);
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
