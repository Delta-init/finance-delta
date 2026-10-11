/**
 * GET /api/v1/service/pending — the Root portal's Pending page asking what is
 * waiting in finance, and on whom — over real HTTP against a real finance API.
 *
 *   1. Only the Root portal's secret gets an answer: none, or a wrong one, is 401.
 *   2. Each kind's total is what a super admin's sidebar badge shows, in each
 *      organization, added up — read from /approvals/summary itself, and from
 *      approvalSummary directly — in the sidebar's order; purchase requests
 *      (read live from HRMS) are left out.
 *   3. Everybody active who may decide a kind is given its whole count, in each
 *      organization they may decide it in; a super admin, every kind
 *      everywhere. Somebody without the permission — or with only half of a
 *      two-part one — gets nothing and is left out; a suspended account, or an
 *      invited or suspended membership, is left out.
 *   4. A person's total is their counts added up; sorted by it, largest first.
 *
 * Run through scripts/root-pending-e2e.sh. Scratch database only.
 */
import mongoose, { Types } from "mongoose";
import { SYSTEM_ROLES } from "@delta/shared";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}

const { hashPassword } = await import("../lib/password");
const { Organization } = await import("../modules/organization/organization.model");
const { Role } = await import("../modules/role/role.model");
const { User } = await import("../modules/user/user.model");
const { Invoice } = await import("../modules/invoice/invoice.model");
const { Expense } = await import("../modules/expense/expense.model");
const { Bill } = await import("../modules/bill/bill.model");
const { PayrollRun } = await import("../modules/payroll/payroll-run.model");
const { FundingRequestModel } = await import("../modules/budget/budget.model");
const { TetraDepositModel } = await import("../modules/tetra-deposit/tetra-deposit.model");
const { approvalSummary } = await import("../modules/approvals/approvals.service");

const API = `http://127.0.0.1:${process.env.E2E_API_PORT}/api/v1`;
const SECRET = process.env.E2E_ROOT_SECRET ?? "";
const PASSWORD = "E2ePassword1!";

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
function step(s: string) { console.log(`\n\x1b[1m${s}\x1b[0m`); }
type Res = { status: number; body: any };
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body).slice(0, 400)}`;
async function http(url: string, method: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const r = await fetch(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
// Emptied, not dropped: the API made its indexes when it started.
for (const c of await mongoose.connection.db!.listCollections().toArray()) await mongoose.connection.db!.collection(c.name).deleteMany({});

step("Two organizations, their roles and their people");
const hq = await Organization.create({ name: "Delta HQ E2E", baseCurrency: "AED" });
const blr = await Organization.create({ name: "Bangalore E2E", baseCurrency: "INR" });
for (const org of [hq, blr]) {
  for (const def of SYSTEM_ROLES) {
    await Role.create({ organizationId: org._id, key: def.key, name: def.name, description: def.description, permissions: def.permissions, isSystem: true });
  }
}
const custom = async (org: typeof hq, key: string, permissions: string[]) =>
  (await Role.create({ organizationId: org._id, key, name: key, permissions }))._id;
const hqDeposits = await custom(hq, "deposits", ["tetra_deposit:approve"]);
const hqInvoices = await custom(hq, "invoices", ["invoice:write", "invoice:read"]);
const blrInvoices = await custom(blr, "invoices", ["invoice:write", "invoice:read"]);
const hqHalfExpense = await custom(hq, "half_expense", ["expense:approve"]); // cannot read the queue: not counted
const hqExpense = await custom(hq, "expense", ["expense:approve", "expense:read:own"]);
const hqReader = await custom(hq, "reader", ["invoice:read", "bill:read", "expense:read", "payroll:read"]);
const blrAccountant = (await Role.findOne({ organizationId: blr._id, key: "accountant" }).lean())!._id;
const hqAdmin = (await Role.findOne({ organizationId: hq._id, key: "admin" }).lean())!._id;

const passwordHash = await hashPassword(PASSWORD);
type M = { org: Types.ObjectId; role: Types.ObjectId; status?: string };
const person = async (name: string, email: string, memberships: M[], extra: Record<string, unknown> = {}) =>
  User.create({
    name, email, passwordHash, status: "active",
    memberships: memberships.map((m) => ({ organizationId: m.org, roleId: m.role, status: m.status ?? "active" })),
    ...extra,
  });
const sam = await person("Sam Super", "Sam.Super@E2E-pending.test", [], { isSuperAdmin: true });
const dina = await person("Dina Deposits", "dina@e2e-pending.test", [{ org: hq._id, role: hqDeposits }]);
await person("Ivy Invoices", "ivy@e2e-pending.test", [{ org: hq._id, role: hqInvoices }, { org: blr._id, role: blrInvoices }]);
await person("Ellen Expense", "ellen@e2e-pending.test", [{ org: hq._id, role: hqExpense }]);
await person("Adam Admin", "adam@e2e-pending.test", [{ org: hq._id, role: hqAdmin }]);
await person("Bea Accountant", "bea@e2e-pending.test", [{ org: blr._id, role: blrAccountant }]);
await person("Hal Half", "hal@e2e-pending.test", [{ org: hq._id, role: hqHalfExpense }]);
await person("Ned Nothing", "ned@e2e-pending.test", [{ org: hq._id, role: hqReader }]);
await person("Sue Suspended", "sue@e2e-pending.test", [{ org: hq._id, role: hqDeposits }], { status: "suspended" });
await person("Ian Invited", "ian@e2e-pending.test", [{ org: hq._id, role: hqDeposits, status: "invited" }]);
await person("Molly Membership-suspended", "molly@e2e-pending.test", [{ org: hq._id, role: hqAdmin, status: "suspended" }]);
await person("Suzy Suspended Super", "suzy@e2e-pending.test", [], { isSuperAdmin: true, status: "suspended" });
check("emails are kept lowercase", (await User.findById(sam._id).lean())!.email === "sam.super@e2e-pending.test");

step("Waiting in each, and some that are not");
// Straight into the collections: only what each count reads, plus a number of
// its own for the unique indexes (invoice, bill, expense, run numbers, ids).
let seq = 0;
const raw = (model: { collection: { insertMany: (docs: any[]) => Promise<unknown> } }, docs: Record<string, unknown>[]) =>
  model.collection.insertMany(docs.map((d) => {
    const n = `E2E-${++seq}`;
    return {
      invoiceNumber: n, billNumber: n, expenseNumber: n, runNumber: n, externalId: n, hrmsOrgId: n,
      createdAt: new Date(), updatedAt: new Date(), ...d,
    };
  }));
const times = (n: number, doc: Record<string, unknown>) => Array.from({ length: n }, () => ({ ...doc }));
// Delta HQ: 3 invoices, 2 bills, 2 expenses, 2 fund requests (one Dina's own), 4 deposits, 2 payroll runs.
await raw(Invoice, [
  ...times(3, { organizationId: hq._id, approval: { state: "pending" }, customerName: "Waiting" }),
  { organizationId: hq._id, approval: { state: "approved" } },
  { organizationId: hq._id, approval: { state: "returned" } },
]);
await raw(Bill, [...times(2, { organizationId: hq._id, status: "pending_approval", vendorName: "V" }), { organizationId: hq._id, status: "open" }]);
await raw(Expense, [...times(2, { organizationId: hq._id, status: "submitted" }), { organizationId: hq._id, status: "approved" }]);
await raw(FundingRequestModel, [
  { organizationId: hq._id, status: "submitted", period: "2026-10", title: "Ads", requestedById: dina._id },
  { organizationId: hq._id, status: "submitted", period: "2026-10", title: "Ads", requestedById: new Types.ObjectId() },
  { organizationId: hq._id, status: "approved", period: "2026-10", title: "Ads" },
]);
await raw(TetraDepositModel, [...times(4, { organizationId: hq._id, status: "pending", student: { name: "S" } }), { organizationId: hq._id, status: "approved" }]);
await raw(PayrollRun, [
  { organizationId: hq._id, status: "imported", period: "2026-09" },
  { organizationId: hq._id, status: "additions", period: "2026-09" },
  { organizationId: hq._id, status: "approved", period: "2026-08" },
]);
// Bangalore: 2 invoices, 1 deposit, 1 expense; nothing else.
await raw(Invoice, times(2, { organizationId: blr._id, approval: { state: "pending" } }));
await raw(TetraDepositModel, [{ organizationId: blr._id, status: "pending", student: { name: "S" } }]);
await raw(Expense, [{ organizationId: blr._id, status: "submitted" }]);

const expectedTotals: Record<string, number> = {
  enrolment_invoices: 5, bills: 2, expense_claims: 3, fund_requests: 2, tetra_deposits: 5, payroll_runs: 2,
};
const ORDER = ["enrolment_invoices", "bills", "expense_claims", "fund_requests", "tetra_deposits", "payroll_runs"];
const typeOf: Record<string, string> = {
  enrolment_invoices: "invoice", bills: "bill", expense_claims: "expense", fund_requests: "fund_request", tetra_deposits: "tetra_deposit", payroll_runs: "payroll",
};

step("Only the Root portal's secret is answered");
{
  const none = await http(`${API}/service/pending`, "GET");
  check("no secret: 401", none.status === 401, show(none));
  const wrong = await http(`${API}/service/pending`, "GET", undefined, { "x-portal-secret": "x".repeat(SECRET.length) });
  check("a wrong secret of the same length: 401", wrong.status === 401, show(wrong));
  const short = await http(`${API}/service/pending`, "GET", undefined, { "x-portal-secret": "nope" });
  check("a wrong secret of another length: 401", short.status === 401, show(short));
  check("none of them says what is waiting", !none.body?.data && !wrong.body?.data && !short.body?.data);
}

const res = await http(`${API}/service/pending`, "GET", undefined, { "x-portal-secret": SECRET });
check("the right secret: 200, success", res.status === 200 && res.body?.success === true, show(res));
const data = res.body?.data ?? {};
const kinds: any[] = data.kinds ?? [];
const people: any[] = data.people ?? [];

step("Each kind is the sidebar's badge, every organization added up");
check("kinds in the sidebar's order, purchase requests left out", same(kinds.map((k) => k.key), ORDER), JSON.stringify(kinds.map((k) => k.key)));
check("labels as the sidebar names them", same(kinds.map((k) => k.label), ["Enrolment invoices", "Bills", "Expenses", "Budgets & Funds", "Tetra Deposits", "Payroll"]));
check("every kind is shared, and has no overdue count", kinds.every((k) => k.shared === true && k.overdue === undefined));
check("totals are what was seeded", same(Object.fromEntries(kinds.map((k) => [k.key, k.total])), expectedTotals), JSON.stringify(kinds));

// The sidebar itself: a super admin, in each organization in turn.
const login = await http(`${API}/auth/login`, "POST", { email: "sam.super@e2e-pending.test", password: PASSWORD });
let token = login.body?.data?.accessToken as string;
check("the super admin signs in", Boolean(token), show(login));
const sidebar: Record<string, number> = {};
let approvalsBadge = 0, procurementBadge = 0;
for (const org of [hq, blr]) {
  const sw = await http(`${API}/auth/switch-org`, "POST", { organizationId: String(org._id) }, { authorization: `Bearer ${token}` });
  token = sw.body?.data?.accessToken ?? token;
  const s = await http(`${API}/approvals/summary`, "GET", undefined, { authorization: `Bearer ${token}` });
  check(`the sidebar in ${org.name} answers`, s.status === 200 && Array.isArray(s.body?.data?.groups), show(s));
  for (const g of s.body?.data?.groups ?? []) {
    sidebar[g.type] = (sidebar[g.type] ?? 0) + g.count;
    if (g.type === "procurement") procurementBadge += g.count;
  }
  approvalsBadge += s.body?.data?.total ?? 0;

  // And approvalSummary itself, read the same way.
  const direct = await approvalSummary({ userId: new Types.ObjectId().toString(), organizationId: String(org._id), role: "", permissions: [], isSuperAdmin: true });
  for (const k of kinds) {
    const want = direct.groups.find((g) => g.type === typeOf[k.key])?.count ?? 0;
    sidebar[`direct:${k.key}`] = (sidebar[`direct:${k.key}`] ?? 0) + want;
  }
}
for (const k of kinds) {
  check(`${k.label}: ${k.total} = the super admin's sidebar badges added up`, k.total === sidebar[typeOf[k.key]!], `sidebar ${sidebar[typeOf[k.key]!]}`);
  check(`${k.label}: ${k.total} = approvalSummary added up`, k.total === sidebar[`direct:${k.key}`], `approvalSummary ${sidebar[`direct:${k.key}`]}`);
}
check("the Approvals badge is the kinds added up (purchase requests aside)",
  approvalsBadge - procurementBadge === kinds.reduce((n, k) => n + k.total, 0), `badge ${approvalsBadge}, procurement ${procurementBadge}`);

step("Everybody who may decide a kind gets its whole count");
const byEmail = new Map(people.map((p) => [p.email, p]));
const expectPerson = (label: string, email: string, counts: Record<string, number>) => {
  const p = byEmail.get(email);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  check(label, Boolean(p) && same(Object.fromEntries(Object.entries(p.counts).sort()), Object.fromEntries(Object.entries(counts).sort())) && p.total === total && p.active === true,
    p ? JSON.stringify(p) : "missing");
};
expectPerson("a super admin: every kind, every organization", "sam.super@e2e-pending.test", expectedTotals);
expectPerson("deposits approver in HQ: HQ's 4 deposits, nothing else", "dina@e2e-pending.test", { tetra_deposits: 4 });
expectPerson("invoice approver in both: 3 + 2 enrolment invoices", "ivy@e2e-pending.test", { enrolment_invoices: 5 });
expectPerson("expense approver who reads their own: HQ's 2 claims (the whole count)", "ellen@e2e-pending.test", { expense_claims: 2 });
expectPerson("admin (*) in HQ: everything waiting in HQ", "adam@e2e-pending.test", { enrolment_invoices: 3, bills: 2, expense_claims: 2, fund_requests: 2, tetra_deposits: 4, payroll_runs: 2 });
{
  // The system Accountant in Bangalore: whatever that role may decide there.
  const acct = SYSTEM_ROLES.find((r) => r.key === "accountant")!.permissions as string[];
  const can = (p: string) => acct.includes("*") || acct.includes(p);
  const want: Record<string, number> = {};
  if (can("invoice:write") && can("invoice:read")) want.enrolment_invoices = 2;
  if (can("tetra_deposit:approve")) want.tetra_deposits = 1;
  if (can("expense:approve") && (can("expense:read") || can("expense:read:own"))) want.expense_claims = 1;
  expectPerson(`the system Accountant in Bangalore: ${JSON.stringify(want)}`, "bea@e2e-pending.test", want);
}
check("expense:approve without reading the queue: left out", !byEmail.has("hal@e2e-pending.test"));
check("no approve permission at all: left out", !byEmail.has("ned@e2e-pending.test"));
check("a suspended account: left out", !byEmail.has("sue@e2e-pending.test"));
check("a suspended super admin: left out", !byEmail.has("suzy@e2e-pending.test"));
check("an invited membership: left out", !byEmail.has("ian@e2e-pending.test"));
check("a suspended membership: left out", !byEmail.has("molly@e2e-pending.test"));
check("nobody listed with nothing", people.every((p) => p.total > 0));
check("ids are the users' ids", same(new Set(people.map((p) => p.id)).has(String(sam._id)), true) && people.every((p) => Types.ObjectId.isValid(p.id)));
check("every email lowercase", people.every((p) => p.email === String(p.email).toLowerCase()));
check("each total is its counts added up", people.every((p) => p.total === Object.entries(p.counts).filter(([k]) => !k.endsWith("_overdue")).reduce((n, [, c]) => n + (c as number), 0)));
check("sorted by total, largest first", people.every((p, i) => i === 0 || people[i - 1].total >= p.total), JSON.stringify(people.map((p) => p.total)));
check("only the six expected people", same(people.map((p) => p.email).sort(), [
  "adam@e2e-pending.test", "bea@e2e-pending.test", "dina@e2e-pending.test", "ellen@e2e-pending.test", "ivy@e2e-pending.test", "sam.super@e2e-pending.test",
]), JSON.stringify(people.map((p) => p.email)));

step("A decision moves the count");
await TetraDepositModel.collection.updateOne({ organizationId: hq._id, status: "pending" }, { $set: { status: "approved" } });
{
  const after = await http(`${API}/service/pending`, "GET", undefined, { "x-portal-secret": SECRET });
  const dep = after.body?.data?.kinds?.find((k: any) => k.key === "tetra_deposits");
  check("one deposit decided: 4 left", dep?.total === 4, JSON.stringify(dep));
  const d = after.body?.data?.people?.find((p: any) => p.email === "dina@e2e-pending.test");
  check("and Dina waits on 3", d?.counts?.tetra_deposits === 3 && d?.total === 3, JSON.stringify(d));
}

await mongoose.disconnect();
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
