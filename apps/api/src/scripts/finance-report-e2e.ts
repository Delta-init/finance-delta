/**
 * GET /api/v1/service/finance-report — the Root portal's Reports → Finance tab — over real HTTP against a real
 * finance API, for September 2026 in Gulf time:
 *
 *   1. expenses    approved ones dated in the month, by submitter, department, category, payment method, paid or
 *                  not; drafts, rejected, voided, other months and other organizations left out
 *   2. approvals   decided in the month — enrolment invoices approved or sent back, an expense, a late entry — by
 *                  who decided, minutes each took, how many over 30; waiting and decided-before left out
 *   3. invoices    issued in the month by salesperson and CRM, outstanding, overdue, void; payments dated in the
 *                  month counted as collected, also on an invoice issued before
 *   4. budget      the Budget page's own figures for the month
 *   5. errors      another organization in its own currency; bad dates; an unknown organization; no secret
 *
 * Run through scripts/finance-report-e2e.sh. Scratch database only.
 */
import mongoose, { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}

const { Organization } = await import("../modules/organization/organization.model");
const { Department } = await import("../modules/department/department.model");
const { Invoice } = await import("../modules/invoice/invoice.model");
const { Expense } = await import("../modules/expense/expense.model");
const { LateEntryModel } = await import("../modules/late-entry/late-entry.model");
const { BudgetAllocationModel, FundingRequestModel } = await import("../modules/budget/budget.model");

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
const FROM = "2026-08-31T20:00:00.000Z", TO = "2026-09-30T19:59:59.999Z"; // 1–30 September, Gulf time
async function get(qs: Record<string, string> = {}, secret: string | null = SECRET) {
  const r = await fetch(`${API}/service/finance-report?${new URLSearchParams({ from: FROM, to: TO, ...qs })}`, { headers: secret === null ? {} : { "x-portal-secret": secret } });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
}

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
for (const c of await mongoose.connection.db!.listCollections().toArray()) await mongoose.connection.db!.collection(c.name).deleteMany({});

const sep = (day: number, h = 12, m = 0) => new Date(Date.UTC(2026, 8, day, h, m));
const now = new Date();

step("Two organizations, September's expenses, approvals, invoices and budget");
const hq = await Organization.create({ name: "Delta HQ E2E", baseCurrency: "AED" });
const blr = await Organization.create({ name: "Bangalore E2E", baseCurrency: "INR" });
const marketing = await Department.create({ organizationId: hq._id, name: "Marketing" });
const accounts = await Department.create({ organizationId: hq._id, name: "Accounts" });

let seq = 0;
const raw = (model: { collection: { insertMany: (docs: any[]) => Promise<unknown> } }, docs: Record<string, unknown>[]) =>
  model.collection.insertMany(docs.map((d) => {
    const n = `E2E-${++seq}`;
    return { invoiceNumber: n, expenseNumber: n, createdAt: now, updatedAt: now, currency: "AED", ...d };
  }));

await raw(Expense, [
  { organizationId: hq._id, expenseNumber: "EXP-1", description: "Flights", category: "travel", categoryName: "Travel", expenseDate: sep(3), submittedByName: "Sara", departmentId: marketing._id,
    totalMinor: 10000, status: "approved", paymentMethod: "card", paidOn: sep(4), approvedByName: "Mo Manager", approvedAt: sep(3, 14) },
  { organizationId: hq._id, expenseNumber: "EXP-2", description: "Paper", categoryName: "Office", expenseDate: sep(10), submittedByName: "Sara", departmentId: accounts._id, totalMinor: 5000, status: "approved" },
  { organizationId: hq._id, expenseNumber: "EXP-3", description: "Taxi", categoryName: "Travel", expenseDate: sep(20), submittedByName: "Ben", departmentId: marketing._id,
    totalMinor: 3000, status: "approved", paymentMethod: "cash", paidOn: sep(20) },
  // Left out: not approved, another month, another organization.
  { organizationId: hq._id, expenseNumber: "EXP-DRAFT", categoryName: "Travel", expenseDate: sep(5), submittedByName: "Sara", totalMinor: 99900, status: "draft" },
  { organizationId: hq._id, expenseNumber: "EXP-REJ", categoryName: "Travel", expenseDate: sep(5), submittedByName: "Sara", totalMinor: 99900, status: "rejected" },
  { organizationId: hq._id, expenseNumber: "EXP-VOID", categoryName: "Travel", expenseDate: sep(5), submittedByName: "Sara", totalMinor: 99900, status: "voided" },
  { organizationId: hq._id, expenseNumber: "EXP-AUG", categoryName: "Travel", expenseDate: new Date(Date.UTC(2026, 7, 31, 18)), submittedByName: "Sara", totalMinor: 99900, status: "approved" }, // 31 Aug 22:00 Gulf
  { organizationId: blr._id, expenseNumber: "EXP-BLR", categoryName: "Travel", expenseDate: sep(5), submittedByName: "Ravi", totalMinor: 700000, currency: "INR", status: "approved" },
]);

const pid = () => new Types.ObjectId();
await raw(Invoice, [
  // Issued in September: Ann's Sales CRM close, part paid and past due; her Draw close paid; Bob's void one.
  { organizationId: hq._id, invoiceNumber: "IN-A", customerName: "Alice", salespersonName: "Ann", issueDate: sep(2), dueDate: sep(12), status: "partial",
    totalMinor: 100000, amountPaidMinor: 40000, balanceMinor: 60000, enrolment: { crm: "delta", course: "Forex" },
    approval: { state: "approved", submittedAt: sep(2, 10), at: sep(2, 11), byName: "Mo Manager" },
    payments: [{ _id: pid(), method: "cash", amountMinor: 40000, paidOn: sep(2), createdAt: sep(2) }] },
  { organizationId: hq._id, invoiceNumber: "IN-B", customerName: "Bea", salespersonName: "Ann", issueDate: sep(15), dueDate: sep(15), status: "paid",
    totalMinor: 50000, amountPaidMinor: 50000, balanceMinor: 0, external: { source: "draw-crm", externalId: "d1" },
    approval: { state: "approved", submittedAt: sep(15, 9), at: sep(15, 9, 10), byName: "Mo Manager" },
    payments: [{ _id: pid(), method: "card", amountMinor: 50000, paidOn: sep(15), createdAt: sep(15) }] },
  { organizationId: hq._id, invoiceNumber: "IN-C", customerName: "Cai", salespersonName: "Bob", issueDate: sep(18), dueDate: sep(19), status: "void", totalMinor: 20000, amountPaidMinor: 0, balanceMinor: 20000 },
  // Issued in August, sent back and paid in September: an approval and money in, not an invoice issued.
  { organizationId: hq._id, invoiceNumber: "IN-R", customerName: "Rex", salespersonName: "Bob", issueDate: new Date(Date.UTC(2026, 7, 20)), dueDate: new Date(Date.UTC(2026, 8, 30)), status: "partial",
    totalMinor: 90000, amountPaidMinor: 30000, balanceMinor: 60000, enrolment: { crm: "remote" },
    approval: { state: "returned", submittedAt: sep(8, 8), at: sep(8, 8, 45), byName: "Fay Finance" },
    payments: [{ _id: pid(), method: "bank_transfer", amountMinor: 30000, paidOn: sep(9), createdAt: sep(9) }, { _id: pid(), method: "cash", amountMinor: 1, paidOn: new Date(Date.UTC(2026, 7, 20)), createdAt: now }] },
  // Waiting, and decided in August: not decided in September.
  { organizationId: hq._id, invoiceNumber: "IN-WAIT", customerName: "Wes", issueDate: new Date(Date.UTC(2026, 7, 1)), status: "sent", totalMinor: 1, balanceMinor: 1, approval: { state: "pending", submittedAt: sep(29) } },
  { organizationId: hq._id, invoiceNumber: "IN-OLD", customerName: "Old", issueDate: new Date(Date.UTC(2026, 7, 1)), status: "paid", totalMinor: 1, balanceMinor: 0,
    approval: { state: "approved", submittedAt: new Date(Date.UTC(2026, 7, 1)), at: new Date(Date.UTC(2026, 7, 1, 1)), byName: "Mo Manager" } },
]);
await LateEntryModel.collection.insertMany([
  { organizationId: hq._id, kind: "expense", refId: pid(), number: "EXP-2", title: "Paper", amountMinor: 5000, currency: "AED", date: sep(10), reason: "Late receipt",
    state: "approved", enteredById: pid(), enteredByName: "Sara", decidedByName: "Mo Manager", decidedAt: sep(21, 12, 20), createdAt: sep(21, 12), updatedAt: sep(21, 12, 20) },
  { organizationId: hq._id, kind: "expense", refId: pid(), number: "EXP-9", title: "Waiting", amountMinor: 100, currency: "AED", date: sep(1), reason: "x",
    state: "pending", enteredById: pid(), enteredByName: "Sara", createdAt: sep(22), updatedAt: sep(22) },
]);
const who = { updatedById: pid(), updatedByName: "Root", changes: [] };
await BudgetAllocationModel.collection.insertMany([
  { organizationId: hq._id, departmentId: marketing._id, period: "2026-09", currency: "AED", allocatedMinor: 500000, ...who, createdAt: now, updatedAt: now },
  { organizationId: hq._id, departmentId: accounts._id, period: "2026-09", currency: "AED", allocatedMinor: 100000, ...who, createdAt: now, updatedAt: now },
  { organizationId: hq._id, departmentId: marketing._id, period: "2026-10", currency: "AED", allocatedMinor: 777700, ...who, createdAt: now, updatedAt: now }, // another month
]);
const fr = (o: Record<string, unknown>) => ({ organizationId: hq._id, departmentId: marketing._id, period: "2026-09", currency: "AED", title: "Ads", purpose: "Ads", requestedById: pid(), requestedByName: "Ben", createdAt: now, updatedAt: now, ...o });
await FundingRequestModel.collection.insertMany([
  fr({ amountMinor: 100000, status: "approved", kind: "topup", reviewedByName: "Mo Manager", reviewedAt: new Date(Date.UTC(2026, 9, 1)) }),
  fr({ amountMinor: 20000, status: "approved", kind: "drawdown", reviewedByName: "Mo Manager", reviewedAt: new Date(Date.UTC(2026, 9, 1)) }),
  fr({ amountMinor: 5000, status: "submitted", kind: "topup" }),
]);

step("Case 5 — permission and errors");
same("no secret: 401", (await get({}, null)).status, 401);
same("a wrong secret: 401", (await get({}, "x".repeat(SECRET.length))).status, 401);
same("from not a date: 422", (await get({ from: "soon" })).status, 422);
same("from after to: 422", (await get({ from: TO, to: FROM })).status, 422);
same("an unknown organization: 422", (await get({ org: String(pid()) })).status, 422);

const r = await get();
same("the report: 200", r.status, 200);
const d = r.body.data;
same("the first organization by default, in its currency", d.org, { id: String(hq._id), name: "Delta HQ E2E", currency: "AED" });
same("every organization offered, each in its own currency", d.organizations.map((o: any) => `${o.name}:${o.currency}`), ["Delta HQ E2E:AED", "Bangalore E2E:INR"]);
same("commission not yet", d.commission.comingSoon, true);

step("Case 1 — expenses");
const e = d.expenses;
same("approved, dated in September only", e.rows.map((x: any) => x.number).sort(), ["EXP-1", "EXP-2", "EXP-3"]);
same("total", { n: e.total.expenses, amount: e.total.amount, paid: e.total.paid_amount, unpaid: e.total.unpaid_amount }, { n: 3, amount: 180, paid: 130, unpaid: 50 });
same("by submitter", e.people.map((p: any) => `${p.name}:${p.amount}`), ["Sara:150", "Ben:30"]);
same("by department", e.teams.map((t: any) => `${t.team}:${t.amount}`), ["Marketing:130", "Accounts:50"]);
same("by category", e.categories.map((c: any) => `${c.name}:${c.count}:${c.amount}`), ["Travel:2:130", "Office:1:50"]);
same("by payment method, unpaid named", e.methods.map((c: any) => `${c.name}:${c.amount}`), ["card:100", "Not paid yet:50", "cash:30"]);
same("by month: September", e.months.map((m: any) => `${m.month}:${m.amount}`), ["2026-09:180"]);

step("Case 2 — approvals decided");
const a = d.approvals;
same("decided in September only", a.rows.map((x: any) => `${x.kind}:${x.outcome}`).sort(),
  ["Enrolment invoices:approved", "Enrolment invoices:approved", "Enrolment invoices:sent back", "Expense claims:approved", "Late entries:approved"]);
same("total: decided, over 30 minutes, average of the timed ones", { n: a.total.decided, ok: a.total.approved, no: a.total.rejected, over: a.total.over_30, avg: a.total.avg_minutes },
  { n: 5, ok: 4, no: 1, over: 2, avg: 34 });
const mo = a.people.find((p: any) => p.name === "Mo Manager"), fay = a.people.find((p: any) => p.name === "Fay Finance");
same("Mo: 4 decided, 3 timed (60, 10, 20 min), one over 30", { n: mo?.decided, timed: mo?.timed, avg: mo?.avg_minutes, over: mo?.over_30 }, { n: 4, timed: 3, avg: 30, over: 1 });
same("Fay: one sent back in 45 minutes", { n: fay?.decided, no: fay?.rejected, avg: fay?.avg_minutes, over: fay?.over_30 }, { n: 1, no: 1, avg: 45, over: 1 });
same("by kind", a.teams.map((t: any) => `${t.team}:${t.decided}`), ["Enrolment invoices:3", "Expense claims:1", "Late entries:1"]);
check("an untimed decision says so", a.rows.find((x: any) => x.kind === "Expense claims")?.minutes === null);

step("Case 3 — invoices");
const i = d.invoices;
same("issued in September", i.rows.map((x: any) => x.number).sort(), ["IN-A", "IN-B", "IN-C"]);
same("total: void counts as nothing; outstanding and overdue on the rest", { n: i.total.invoices, amount: i.total.amount, out: i.total.outstanding, overdue: i.total.overdue, overdueAmt: i.total.overdue_amount, void: i.total.void, paid: i.total.paid },
  { n: 3, amount: 1500, out: 600, overdue: 1, overdueAmt: 600, void: 1, paid: 1 });
same("collected: payments dated in September, also on an August invoice", { c: i.total.collected, p: i.total.payments }, { c: 1200, p: 3 });
same("by salesperson", i.people.map((p: any) => `${p.name}:${p.invoices}:${p.amount}:${p.collected}`), ["Ann:2:1500:900", "Bob:1:0:300"]);
same("by CRM", i.teams.map((t: any) => `${t.team}:${t.invoices}:${t.collected}`).sort(), ["Draw:1:500", "Remote:0:300", "Sales CRM:1:400", "Typed in finance:1:0"]);
same("by status", i.statuses.map((s: any) => `${s.name}:${s.count}`).sort(), ["paid:1", "partial:1", "void:1"]);
same("payments listed", i.payments.map((p: any) => `${p.number}:${p.amount}`).sort(), ["IN-A:400", "IN-B:500", "IN-R:300"]);

step("Case 4 — budget");
const b = d.budget;
same("September only, per department", b.rows.map((x: any) => `${x.owner}:${x.period}`).sort(), ["Accounts:2026-09", "Marketing:2026-09"]);
const mk = b.people.find((p: any) => p.name === "Marketing");
same("Marketing: the Budget page's figures", { al: mk?.allocated, up: mk?.topups, down: mk?.drawdowns, spent: mk?.spent, av: mk?.available, pend: mk?.pending },
  { al: 5000, up: 1000, down: 200, spent: 130, av: 5670, pend: 1 });
same("total", { al: b.total.allocated, spent: b.total.spent, av: b.total.available }, { al: 6000, spent: 180, av: 6620 });

step("Case 5 — another organization, its own currency");
const blrR = (await get({ org: String(blr._id) })).body.data;
same("Bangalore in INR, only its expense", { cur: blrR.org.currency, rows: blrR.expenses.rows.map((x: any) => x.number), amount: blrR.expenses.total.amount }, { cur: "INR", rows: ["EXP-BLR"], amount: 7000 });
same("nothing of HQ's", { inv: blrR.invoices.rows.length, appr: blrR.approvals.rows.length, budget: blrR.budget.rows.length }, { inv: 0, appr: 0, budget: 0 });

await mongoose.disconnect();
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
