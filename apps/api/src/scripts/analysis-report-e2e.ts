/**
 * The Expense and Revenue reports (the user, 2026-10-24: "a report on expenses and revenue — by category, employee and
 * department, with more filters"), against a scratch database through finance's report service.
 *
 * What it proves:
 *   Expenses — approved and waiting count, drafts / rejected / voided don't; grouped by category (with subcategories),
 *   employee (the one named, else who submitted it), submitter, department, method, bank account, source, paid or
 *   not, month; filters keep only the matching ones and the options still list the whole period; P&L only leaves out
 *   advances; by paid date; paid / unpaid totals; another organization's never counted.
 *   Revenue — invoices issued less credit notes, by salesperson, the salesperson's department, course, CRM, academy,
 *   status; void and drafts out; collected by payment date, method and bank; another currency in the organization's;
 *   outstanding and collected on the invoices; filters; the controller's checks (bad basis, groupBy, dates).
 *
 * Run through scripts/analysis-report-e2e.sh (throwaway mongod, no .env anywhere).
 */
import mongoose, { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}
const { getExpenseAnalysis, getRevenueAnalysis } = await import("../modules/reports/analysis.service");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const same = (label: string, got: unknown, want: unknown) => check(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
async function refused(p: Promise<unknown>, like: RegExp): Promise<string> {
  try { await p; return "not refused"; } catch (e) { const m = (e as Error).message; return like.test(m) ? "" : m; }
}

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();
const db = mongoose.connection.db!;

const ORG = new Types.ObjectId(), org = String(ORG), OTHER = new Types.ObjectId();
await db.collection("organizations").insertMany([{ _id: ORG, name: "Delta HQ", baseCurrency: "AED" }, { _id: OTHER, name: "Elsewhere", baseCurrency: "AED" }]);
const SALES = new Types.ObjectId(), OPS = new Types.ObjectId();
await db.collection("departments").insertMany([{ _id: SALES, organizationId: ORG, name: "Sales" }, { _id: OPS, organizationId: ORG, name: "Operations" }]);
const asha = new Types.ObjectId(), bilal = new Types.ObjectId(), clerk = new Types.ObjectId();
await db.collection("users").insertMany([
  { _id: asha, name: "Asha", email: "asha@e2e.local", memberships: [{ organizationId: ORG, departmentId: SALES, status: "active" }] },
  { _id: bilal, name: "Bilal", email: "bilal@e2e.local", memberships: [{ organizationId: ORG, departmentId: OPS, status: "active" }] },
  { _id: clerk, name: "Clerk", email: "clerk@e2e.local", memberships: [{ organizationId: ORG, status: "active" }] },
]);
const ADCB = new Types.ObjectId();
await db.collection("bankaccounts").insertOne({ _id: ADCB, organizationId: ORG, accountName: "Delta Bank", accountType: "current", currency: "AED", isActive: true });

const at = (d: string) => new Date(`${d}T00:00:00.000Z`);
let n = 0;
const exp = (o: Record<string, unknown>) => ({
  organizationId: ORG, expenseNumber: `EXP-${String(++n).padStart(3, "0")}`, category: "advertising_marketing", subcategory: "meta_ads", subcategoryName: "Meta Ads",
  description: `Expense ${n}`, expenseDate: at("2026-10-05"), totalMinor: 10_000, currency: "AED", status: "approved", submittedById: clerk, submittedByName: "Clerk", ...o,
});
await db.collection("expenses").insertMany([
  exp({ salespersonId: asha, salespersonName: "Asha", departmentId: SALES, paymentMethod: "card", bankAccountId: ADCB, paidOn: at("2026-10-06"), totalMinor: 30_000 }), // 001
  exp({ subcategory: "google_ads", subcategoryName: "Google Ads", departmentId: SALES, status: "submitted", totalMinor: 5_000 }),                              // 002 waiting, unpaid, no employee named
  exp({ category: "bank_fees", subcategory: "bank_charges", subcategoryName: "Bank Charges", departmentId: OPS, salespersonId: bilal, salespersonName: "Bilal",
    paymentMethod: "bank_transfer", paymentAccount: "ADCB old", paidOn: at("2026-11-02"), expenseDate: at("2026-10-20"), totalMinor: 2_000 }),          // 003 paid next month, typed account name
  exp({ category: "employee_advances", subcategory: null, subcategoryName: "", totalMinor: 50_000, paidOn: at("2026-10-07"), paymentMethod: "cash" }),   // 004 not in the P&L
  exp({ source: { kind: "bill", key: "b1" }, submittedById: null, submittedByName: "Bills", totalMinor: 7_000, expenseDate: at("2026-09-28") }),       // 005 September, a bill's
  exp({ status: "draft", totalMinor: 99_000 }), exp({ status: "rejected", totalMinor: 99_000 }), exp({ status: "voided", totalMinor: 99_000 }),          // 006–008 never
  exp({ organizationId: OTHER, totalMinor: 99_000 }),                                                                                                    // 009 another organization
]);

step("1. Expenses by category");
const OCT = { from: "2026-10-01", to: "2026-10-31" };
let r = await getExpenseAnalysis(org, { ...OCT, basis: "expense", groupBy: "category", filters: {} });
same("October: approved and waiting, not drafts / rejected / voided / September / elsewhere", r.records.map((x) => x.number).sort(), ["EXP-001", "EXP-002", "EXP-003", "EXP-004"]);
same("total 870.00 over 4", [r.totals.amountMinor, r.totals.count], [87_000, 4]);
same("paid 820.00, not paid 50.00", [r.totals.paidMinor, r.totals.unpaidMinor], [82_000, 5_000]);
const adv = r.groups.find((g) => g.name === "Advertising & Marketing");
check("by category, biggest first, names from the categories", r.groups[0]?.name === "Employee Advances Receivable" && adv?.amountMinor === 35_000, JSON.stringify(r.groups.map((g) => [g.name, g.amountMinor])));
same("…a category opens into its subcategories", adv?.sub?.map((s) => [s.name, s.amountMinor]), [["Meta Ads", 30_000], ["Google Ads", 5_000]]);
same("the currency is the organization's", r.currency, "AED");

step("2. Employee-wise, department-wise and the rest");
const by = async (groupBy: string, extra: Record<string, unknown> = {}) =>
  (await getExpenseAnalysis(org, { ...OCT, basis: "expense", groupBy, filters: {}, ...extra })).groups.map((g) => [g.name, g.amountMinor]);
same("employee: the one named, else who submitted it", await by("employee"), [["Clerk", 55_000], ["Asha", 30_000], ["Bilal", 2_000]]);
same("submitted by", await by("submittedBy"), [["Clerk", 87_000]]);
same("department", await by("department"), [["No department", 50_000], ["Sales", 35_000], ["Operations", 2_000]]);
same("payment method", await by("method"), [["Cash", 50_000], ["Card", 30_000], ["Not said", 5_000], ["Bank transfer", 2_000]]);
same("bank account — an account, a name typed, none", await by("bank"), [["No bank account", 55_000], ["Delta Bank", 30_000], ["ADCB old", 2_000]]);
same("status", await by("status"), [["Approved", 82_000], ["Waiting for approval", 5_000]]);
same("P&L only: the advance is left out", await by("category", { pnlOnly: true }), [["Advertising & Marketing", 35_000], ["Bank Fees & Charges", 2_000]]);

step("3. Filters");
r = await getExpenseAnalysis(org, { ...OCT, basis: "expense", groupBy: "category", filters: { department: String(SALES) } });
same("Sales only", r.records.map((x) => x.number).sort(), ["EXP-001", "EXP-002"]);
check("…the options still list every department of the period", r.options.department?.length === 3 && r.options.department.some((o) => o.name === "Operations"), JSON.stringify(r.options.department));
r = await getExpenseAnalysis(org, { ...OCT, basis: "expense", groupBy: "employee", filters: { department: String(SALES), paid: "unpaid" } });
same("Sales and not paid: EXP-002", r.records.map((x) => x.number), ["EXP-002"]);
const noDept = (await getExpenseAnalysis(org, { ...OCT, basis: "expense", groupBy: "category", filters: {} })).options.department?.find((o) => o.name === "No department")?.key ?? "";
same("'No department' is a filter of its own", (await getExpenseAnalysis(org, { ...OCT, basis: "expense", groupBy: "category", filters: { department: noDept } })).records.map((x) => x.number), ["EXP-004"]);
same("a search on the number or words", (await getExpenseAnalysis(org, { ...OCT, basis: "expense", groupBy: "category", filters: {}, search: "expense 3" })).records.map((x) => x.number), ["EXP-003"]);
same("source: a bill's expense is there (September)", (await getExpenseAnalysis(org, { from: "2026-09-01", to: "2026-09-30", basis: "expense", groupBy: "source", filters: {} })).groups.map((g) => g.name), ["Supplier bill"]);

step("4. By paid date, all time");
r = await getExpenseAnalysis(org, { from: "2026-10-01", to: "2026-10-31", basis: "paid", groupBy: "month", filters: {} });
same("paid in October: 001 and 004 (003 was paid in November, 002 not at all)", r.records.map((x) => x.number).sort(), ["EXP-001", "EXP-004"]);
r = await getExpenseAnalysis(org, { from: "", to: "", basis: "expense", groupBy: "month", filters: {} });
same("all time, by month, newest first", r.groups.map((g) => [g.name, g.count]), [["October 2026", 4], ["September 2026", 1]]);
same("…and the trend oldest first", r.months.map((m) => m.month), ["2026-09", "2026-10"]);
let why = await refused(getExpenseAnalysis(org, { ...OCT, basis: "whenever", groupBy: "category", filters: {} }), /basis/);
check("a basis that isn't one is refused", !why, why);

step("5. Revenue: invoiced, less credit notes");
const CUST = new Types.ObjectId(), CUST2 = new Types.ObjectId();
let inum = 0;
const inv = (o: Record<string, unknown>) => ({
  _id: new Types.ObjectId(), organizationId: ORG, invoiceNumber: `INV-${String(++inum).padStart(3, "0")}`, customerId: CUST, customerName: "Sara", salespersonId: asha, salespersonName: "Asha",
  issueDate: at("2026-10-03"), status: "sent", currency: "AED", totalMinor: 100_000, baseTotalMinor: 100_000, balanceMinor: 100_000, exchangeRate: 1, payments: [],
  lineItems: [{ description: "Forex Mastery" }], ...o,
});
const i1 = inv({ enrolment: { course: "DGMP", crm: "delta", academy: "dubai" }, status: "partial", balanceMinor: 40_000,
  payments: [{ _id: new Types.ObjectId(), amountMinor: 60_000, paidOn: at("2026-10-04"), method: "card", bankAccountId: ADCB, receiptNumber: "RCT-1" }] });
const i2 = inv({ salespersonId: bilal, salespersonName: "Bilal", customerId: CUST2, customerName: "Omar", enrolment: { course: "DQMP", crm: "draw", academy: "bangalore" }, status: "paid", balanceMinor: 0,
  payments: [{ _id: new Types.ObjectId(), amountMinor: 50_000, paidOn: at("2026-10-10"), method: "tabby" }, { _id: new Types.ObjectId(), amountMinor: 50_000, paidOn: at("2026-11-01"), method: "cash" }] });
const i3 = inv({ currency: "USD", totalMinor: 10_000, baseTotalMinor: 36_700, balanceMinor: 0, exchangeRate: 3.67, status: "paid", salespersonId: clerk, salespersonName: "Clerk",
  payments: [{ _id: new Types.ObjectId(), amountMinor: 10_000, paidOn: at("2026-10-12"), method: "bank_transfer" }] });                            // typed, in USD
const i4 = inv({ issueDate: at("2026-09-20"), totalMinor: 20_000, baseTotalMinor: 20_000, balanceMinor: 20_000 });                                    // September, credited in October
await db.collection("invoices").insertMany([i1, i2, i3, i4, inv({ status: "void" }), inv({ status: "draft" }), inv({ organizationId: OTHER })]);
await db.collection("creditnotes").insertMany([
  { organizationId: ORG, creditNoteNumber: "CN-1", invoiceId: i1._id, invoiceNumber: i1.invoiceNumber, customerId: CUST, customerName: "Sara", reason: "Discount", status: "issued", totalMinor: 10_000, issuedAt: at("2026-10-15") },
  { organizationId: ORG, creditNoteNumber: "CN-2", invoiceId: i4._id, invoiceNumber: i4.invoiceNumber, customerId: CUST, customerName: "Sara", reason: "Refund", status: "applied", totalMinor: 5_000, issuedAt: at("2026-10-16") },
  { organizationId: ORG, creditNoteNumber: "CN-3", invoiceId: i1._id, invoiceNumber: i1.invoiceNumber, customerId: CUST, customerName: "Sara", reason: "Draft", status: "draft", totalMinor: 77_000, issuedAt: at("2026-10-15") },
]);
let v = await getRevenueAnalysis(org, { ...OCT, basis: "invoiced", groupBy: "salesperson", filters: {} });
same("October: 3 invoices and 2 credit notes (a draft note, void / draft invoices, September's invoice and elsewhere out)",
  v.records.map((x) => x.number).sort(), ["CN-1", "CN-2", "INV-001", "INV-002", "INV-003"]);
same("invoiced 2,367.00 (the USD one at 3.67), credit notes 150.00, net 2,217.00", [v.totals.invoicedMinor, v.totals.creditMinor, v.totals.amountMinor], [236_700, 15_000, 221_700]);
same("outstanding on them 400.00, collected on them 2,467.00", [v.totals.outstandingMinor, v.totals.collectedMinor], [40_000, 60_000 + 100_000 + 36_700]);
same("by salesperson (a credit note counts against the invoice's)", v.groups.map((g) => [g.name, g.amountMinor]), [["Asha", 85_000], ["Bilal", 100_000], ["Clerk", 36_700]].sort((a, b) => (b[1] as number) - (a[1] as number)));
const rv = async (groupBy: string, filters: Record<string, string> = {}, basis = "invoiced") => (await getRevenueAnalysis(org, { ...OCT, basis, groupBy, filters })).groups.map((g) => [g.name, g.amountMinor]);
same("by department — the salesperson's", await rv("department"), [["Operations", 100_000], ["Sales", 85_000], ["No department", 36_700]]);
same("by course — the enrolment's, else the first line", await rv("course"), [["DQMP", 100_000], ["DGMP", 90_000], ["Forex Mastery", 31_700]]);
same("by CRM, as finance names them", await rv("crm"), [["Draw", 100_000], ["Sales CRM", 90_000], ["Typed in finance", 31_700]]);
same("by academy", await rv("academy"), [["Bangalore", 100_000], ["Dubai", 90_000], ["Not said", 31_700]]);
same("by status", await rv("status"), [["Paid", 136_700], ["Part paid", 90_000], ["Not paid", -5_000]]);
same("filtered to Asha", (await getRevenueAnalysis(org, { ...OCT, basis: "invoiced", groupBy: "course", filters: { salesperson: String(asha) } })).records.map((x) => x.number).sort(), ["CN-1", "CN-2", "INV-001"]);

step("6. Revenue: collected");
v = await getRevenueAnalysis(org, { ...OCT, basis: "collected", groupBy: "method", filters: {} });
same("payments in October: 600 + 500 + 367 (Bilal's November cash out)", [v.totals.amountMinor, v.totals.count], [146_700, 3]);
same("by method", v.groups.map((g) => [g.name, g.amountMinor]), [["Card", 60_000], ["Tabby", 50_000], ["Bank transfer", 36_700]]);
same("by bank account", await rv("bank", {}, "collected"), [["No bank account", 86_700], ["Delta Bank", 60_000]]);
same("filtered to the Draw CRM", (await getRevenueAnalysis(org, { ...OCT, basis: "collected", groupBy: "salesperson", filters: { crm: "draw" } })).groups.map((g) => [g.name, g.amountMinor]), [["Bilal", 50_000]]);
why = await refused(getRevenueAnalysis(org, { ...OCT, basis: "expense", groupBy: "salesperson", filters: {} }), /basis/);
check("a basis that isn't one is refused", !why, why);

console.log(`\n${checks - failures}/${checks} passed`);
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
