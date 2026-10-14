/**
 * HRMS hiring requests and salary advances in finance (2026-10-15), against a
 * real API process and a stand-in HRMS served from here:
 *
 *   Case 1  the Hiring requests page: what HRMS has waiting, across linked
 *           HRMS organisations; approve (the answer reaches HRMS, with who and
 *           the note), reject (a reason is required), deciding again resends
 *           rather than making a second, the opposite decision refused, a
 *           request no longer waiting, an organisation not linked;
 *   Case 2  HRMS failing half-way: recorded here, "decide it again to resend",
 *           and the resend finishes it;
 *   Case 3  Approvals: hiring requests and salary advances counted for whoever
 *           holds expense:approve, listed Pending (read live from HRMS),
 *           Approved / Rejected (kept here), searched, and HRMS unreadable said
 *           on those kinds alone;
 *   Case 4  permissions: an employee is refused.
 *
 * Run through scripts/hiring-approvals-e2e.sh (throwaway mongod + API, no .env).
 */
import mongoose, { Types } from "mongoose";
import { SYSTEM_ROLES } from "@delta/shared";
import { hashPassword } from "../lib/password";
import { Organization } from "../modules/organization/organization.model";
import { Role } from "../modules/role/role.model";
import { User } from "../modules/user/user.model";
import { Department } from "../modules/department/department.model";
import { Expense } from "../modules/expense/expense.model";
import { PayrollOrgLink } from "../modules/payroll-mapping/org-link.model";
import { HiringDecision } from "../modules/hiring/hiring-decision.model";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\/[^/?]*e2e/.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}
const BASE = `http://127.0.0.1:${process.env.E2E_API_PORT ?? "4134"}/api/v1`;
const PASSWORD = "E2ePassword1!";

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const show = (v: unknown) => JSON.stringify(v).slice(0, 400);

type Res = { status: number; body: any };
async function request(method: string, p: string, body?: unknown, token?: string): Promise<Res> {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function login(email: string): Promise<string> {
  const r = await request("POST", "/auth/login", { email, password: PASSWORD });
  const token = r.body?.data?.accessToken as string | undefined;
  if (!token) throw new Error(`login failed for ${email}: ${r.status} ${show(r.body)}`);
  return token;
}

/* ── A stand-in HRMS: its integration routes for hiring requests and advances ── */
const H1 = "hrms-org-dubai", H2 = "hrms-org-blr", H9 = "hrms-org-down";
const hiring = new Map<string, any[]>(); // hrmsOrgId → waiting requisitions
const advances = new Map<string, any[]>();
const told: { path: string; org: string; body: any }[] = [];
const fail = { down: false, decideOnce: false };
const req = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  _id: id, title, type: "new_headcount", headcount: 1, salaryMin: 4000, salaryMax: 6000, currency: "AED",
  department: { name: "Sales" }, designation: "Sales Executive", location: "dubai", employmentType: "full_time",
  justification: "Two new teams", targetStartDate: null, jdText: "Sell courses", jdFileName: "", raisedBy: { name: "Maneesh", email: "m@hr.test" },
  replacing: null, hrApprovedAt: new Date(Date.now() - 3_600_000).toISOString(), hrApprovedBy: "HR Head", createdAt: new Date(Date.now() - 7_200_000).toISOString(), ...extra,
});
const hrms = Bun.serve({
  port: Number(process.env.E2E_HRMS_PORT ?? 5094),
  hostname: "127.0.0.1",
  async fetch(r) {
    const url = new URL(r.url);
    const org = url.searchParams.get("organizationId") ?? "";
    const send = (status: number, data: unknown, message = "ok") => Response.json(status < 400 ? { success: true, message, data } : { success: false, message }, { status });
    if (!r.headers.get("x-delta-signature")) return send(401, null, "unsigned");
    if (fail.down || org === H9) return send(500, null, "HRMS is down");
    const p = url.pathname.replace(/^\/api\/v1\/integrations/, "");
    if (r.method === "GET" && p === "/hiring/requisitions") return send(200, hiring.get(org) ?? []);
    if (r.method === "GET" && p === "/advances/requests") return send(200, advances.get(org) ?? []);
    const m = p.match(/^\/hiring\/requisitions\/([^/]+)\/(approve|reject)$/);
    if (r.method === "POST" && m) {
      if (fail.decideOnce) { fail.decideOnce = false; return send(502, null, "HRMS hiccup"); }
      const list = hiring.get(org) ?? [];
      const i = list.findIndex((x) => x._id === m[1]);
      if (i < 0) return send(404, null, "Not waiting");
      const body = await r.json();
      told.push({ path: p, org, body });
      list.splice(i, 1);
      return send(200, { _id: m[1], status: m[2] === "approve" ? "approved" : "rejected" });
    }
    return send(404, null, "no route");
  },
});

const summaryOf = async (t: string) => (await request("GET", "/approvals/summary", undefined, t)).body?.data;
const group = (s: any, type: string) => (s?.groups ?? []).find((g: any) => g.type === type);
const listOf = async (t: string, qs: string) => {
  const b = (await request("GET", `/approvals/list?${qs}`, undefined, t)).body;
  return { rows: (b?.data ?? []) as any[], meta: b?.meta ?? {} };
};

async function main() {
  await mongoose.connect(uri);
  if (mongoose.connection.host !== "127.0.0.1" || !/e2e/.test(mongoose.connection.db!.databaseName)) {
    console.error(`Refusing to run: connected to ${mongoose.connection.host}/${mongoose.connection.db!.databaseName}`);
    process.exit(1);
  }
  await mongoose.connection.db!.dropDatabase();

  step("An organization linked to two HRMS organisations, an admin and an employee");
  const org = await Organization.create({ name: "Hiring E2E", baseCurrency: "AED" });
  for (const def of SYSTEM_ROLES) {
    await Role.create({ organizationId: org._id, key: def.key, name: def.name, description: def.description, permissions: def.permissions, isSystem: true });
  }
  const roleId = async (key: string) => (await Role.findOne({ organizationId: org._id, key }).lean())!._id;
  const dept = await Department.create({ organizationId: org._id, name: "Finance" });
  const passwordHash = await hashPassword(PASSWORD);
  const mk = (name: string, email: string, role: Types.ObjectId) =>
    User.create({ name, email, passwordHash, status: "active", memberships: [{ organizationId: org._id, roleId: role, departmentId: dept._id, status: "active" }] });
  await mk("Aisha Admin", "admin@e2e-hiring.test", await roleId("admin"));
  await mk("Eli Employee", "employee@e2e-hiring.test", await roleId("employee"));
  const tAdmin = await login("admin@e2e-hiring.test");
  const tEmp = await login("employee@e2e-hiring.test");
  for (const [id, name] of [[H1, "Delta Dubai HRMS"], [H2, "Delta Bangalore HRMS"]]) {
    await PayrollOrgLink.collection.insertOne({ organizationId: org._id, hrmsOrgId: id, hrmsOrgName: name, isActive: true, createdAt: new Date(), updatedAt: new Date() });
  }
  hiring.set(H1, [req("rq1", "Sales Executive", { headcount: 2 }), req("rq2", "Video Editor", { type: "replacement", replacing: { name: "Old Editor", designation: "Editor", salary: 3000 } })]);
  hiring.set(H2, [req("rq3", "Counsellor", { currency: "INR", salaryMin: 30000, salaryMax: 45000, department: { name: "Bangalore Sales" } })]);
  advances.set(H1, [{ _id: "adv1", amount: 3000, currency: "AED", reason: "Rent", monthlySalary: 6000, months: 3, startMonth: "2026-11",
    employee: { _id: "e1", name: "Ravi", department: { _id: "d1", name: "Sales" } }, user: { _id: "u1", name: "Ravi" }, hrReviewedBy: { _id: "h1", name: "HR Head" },
    hrReviewedAt: new Date(Date.now() - 600_000).toISOString(), createdAt: new Date(Date.now() - 900_000).toISOString() }]);

  step("Case 1 — the Hiring requests page");
  let r = await request("GET", "/hiring", undefined, tAdmin);
  const rows = r.body?.data ?? [];
  check("lists what HRMS has waiting, from both linked HRMS organisations", r.status === 200 && rows.length === 3
    && rows.some((x: any) => x._id === "rq3" && x.hrmsOrgName === "Delta Bangalore HRMS" && x.currency === "INR"), show(r.body));
  check("…with the request's detail (headcount, salary range, raiser, the leaver for a replacement)",
    rows.some((x: any) => x._id === "rq1" && x.headcount === 2 && x.salaryMax === 6000 && x.raisedBy?.name === "Maneesh")
    && rows.some((x: any) => x._id === "rq2" && x.replacing?.salary === 3000));
  r = await request("POST", "/hiring/rq1/approve", { hrmsOrgId: H1, note: "Budgeted in Q4" }, tAdmin);
  check("approve: 200, and HRMS is told — with who and the note", r.status === 200 && told.at(-1)?.path === "/hiring/requisitions/rq1/approve"
    && told.at(-1)?.body?.note === "Budgeted in Q4" && told.at(-1)?.body?.by === "Aisha Admin" && told.at(-1)?.org === H1, show({ r: r.body, told: told.at(-1) }));
  const d1 = await HiringDecision.findOne({ requisitionId: "rq1" }).lean();
  check("…kept here: approved, by whom, delivered, the request's title and salary", d1?.decision === "approved" && d1.decidedByName === "Aisha Admin"
    && !!d1.deliveredAt && d1.request?.title === "Sales Executive" && d1.request?.salaryMax === 6000, show(d1));
  r = await request("POST", "/hiring/rq1/approve", { hrmsOrgId: H1 }, tAdmin);
  check("approving it again: nothing new, no second decision", r.status === 200 && r.body?.data?.alreadyDone === true && (await HiringDecision.countDocuments({ requisitionId: "rq1" })) === 1, show(r.body));
  r = await request("POST", "/hiring/rq1/reject", { hrmsOrgId: H1, note: "Changed my mind" }, tAdmin);
  check("rejecting what was approved: 409", r.status === 409, show(r.body));
  r = await request("POST", "/hiring/rq2/reject", { hrmsOrgId: H1 }, tAdmin);
  check("reject without a reason: refused", r.status === 422 || r.status === 400, `${r.status}`);
  r = await request("POST", "/hiring/rq2/reject", { hrmsOrgId: H1, note: "Paid above the old salary — not budgeted" }, tAdmin);
  check("reject with a reason: HRMS told, kept as rejected", r.status === 200 && told.at(-1)?.path === "/hiring/requisitions/rq2/reject"
    && /not budgeted/.test(told.at(-1)?.body?.note) && (await HiringDecision.findOne({ requisitionId: "rq2" }).lean())?.decision === "rejected", show(r.body));
  r = await request("POST", "/hiring/rq-gone/approve", { hrmsOrgId: H1 }, tAdmin);
  check("a request no longer waiting in HRMS: 404 saying so", r.status === 404 && /no longer waiting/.test(r.body?.error?.message ?? ""), show(r.body));
  r = await request("POST", "/hiring/rq3/approve", { hrmsOrgId: "hrms-not-linked" }, tAdmin);
  check("an HRMS organisation not linked: 403", r.status === 403, show(r.body));

  step("Case 2 — HRMS failing half-way");
  fail.decideOnce = true;
  r = await request("POST", "/hiring/rq3/approve", { hrmsOrgId: H2 }, tAdmin);
  check("recorded here, HRMS not told: 503 saying approve again to resend", r.status === 503 && /Approve it again to resend/.test(r.body?.error?.message ?? ""), show(r.body));
  r = await request("GET", "/hiring", undefined, tAdmin);
  check("…the page shows it decided here but not delivered", r.body?.data?.find((x: any) => x._id === "rq3")?.undelivered?.decision === "approved", show(r.body?.data));
  r = await request("POST", "/hiring/rq3/approve", { hrmsOrgId: H2 }, tAdmin);
  const d3 = await HiringDecision.findOne({ requisitionId: "rq3" }).lean();
  check("approving again resends: delivered, one decision", r.status === 200 && !!d3?.deliveredAt && (await HiringDecision.countDocuments({ requisitionId: "rq3" })) === 1, show(r.body));

  step("Case 3 — Approvals");
  hiring.set(H1, [req("rq4", "Accountant", { department: { name: "Finance" } })]);
  // A paid-out advance, as the Advances page records it.
  await Expense.collection.insertOne({ organizationId: org._id, expenseNumber: "EXP-9", description: "Salary advance — Meera", category: "Salary advance",
    totalMinor: 200000, currency: "AED", status: "paid", approvedByName: "Aisha Admin", approvedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
    source: { kind: "hrms_advance", key: `hrms-advance:${H1}:adv0`, hrmsOrgId: H1, requestId: "adv0", round: 0, deliveredAt: new Date() } });
  let s = await summaryOf(tAdmin);
  check("the summary counts hiring requests waiting (1, read live)", group(s, "hiring")?.count === 1 && group(s, "hiring")?.items?.[0]?.title === "Accountant", show(group(s, "hiring")));
  check("…and salary advances waiting (1), with the amount", group(s, "salary_advance")?.count === 1 && group(s, "salary_advance").items[0].amountMinor === 300000
    && group(s, "salary_advance").items[0].href === "/advances", show(group(s, "salary_advance")));
  let l = await listOf(tAdmin, "status=pending&type=hiring");
  check("Pending: the hiring request, raised by its raiser, opening the Hiring page", l?.rows?.length === 1 && l.rows[0].title === "Accountant"
    && l.rows[0].raisedBy === "Maneesh" && l.rows[0].href === "/hiring", show(l));
  l = await listOf(tAdmin, "status=approved&type=hiring");
  check("Approved: the two approved here, by whom", l?.rows?.length === 2 && l.rows.every((x: any) => x.decidedBy === "Aisha Admin")
    && l.rows.some((x: any) => x.title === "2 × Sales Executive"), show(l));
  l = await listOf(tAdmin, "status=rejected&type=hiring");
  check("Rejected: with the reason", l?.rows?.length === 1 && /not budgeted/.test(l.rows[0].reason ?? ""), show(l));
  l = await listOf(tAdmin, "status=pending&type=salary_advance");
  check("Pending: the advance, recovered over its months, raised by HR", l?.rows?.length === 1 && /3 months/.test(l.rows[0].subtitle) && l.rows[0].raisedBy === "HR Head", show(l));
  l = await listOf(tAdmin, "status=approved&type=salary_advance");
  check("Approved: the paid-out advance's expense", l?.rows?.some((x: any) => x.title === "Salary advance — Meera" && x.href.startsWith("/expenses/")), show(l));
  l = await listOf(tAdmin, "status=all&search=counsellor");
  check("search finds a decided hiring request by its title", l?.rows?.some((x: any) => x.type === "hiring" && x.title === "Counsellor"), show(l?.rows));
  // HRMS's answers are kept two minutes, so an organisation linked to an HRMS that never answers.
  const org2 = await Organization.create({ name: "Hiring E2E Two", baseCurrency: "AED" });
  for (const def of SYSTEM_ROLES) {
    await Role.create({ organizationId: org2._id, key: def.key, name: def.name, description: def.description, permissions: def.permissions, isSystem: true });
  }
  const admin2Role = (await Role.findOne({ organizationId: org2._id, key: "admin" }).lean())!._id;
  await User.create({ name: "Second Admin", email: "admin2@e2e-hiring.test", passwordHash, status: "active", memberships: [{ organizationId: org2._id, roleId: admin2Role, status: "active" }] });
  await PayrollOrgLink.collection.insertOne({ organizationId: org2._id, hrmsOrgId: H9, hrmsOrgName: "Unreachable HRMS", isActive: true, createdAt: new Date(), updatedAt: new Date() });
  const tAdmin2 = await login("admin2@e2e-hiring.test");
  l = await listOf(tAdmin2, "status=pending");
  const said = (l.meta?.unavailable ?? []) as string[];
  check("HRMS unreadable: hiring requests and salary advances say so", said.some((u) => /Hiring requests/.test(u)) && said.some((u) => /Salary advances/.test(u)), show(said));
  s = await summaryOf(tAdmin2);
  check("…and their counts say they could not be read, not zero", !!group(s, "hiring")?.unavailable && !!group(s, "salary_advance")?.unavailable, show(s?.groups));

  step("Case 4 — permissions");
  check("an employee: the Hiring page refused", (await request("GET", "/hiring", undefined, tEmp)).status === 403);
  check("…and approving refused", (await request("POST", "/hiring/rq4/approve", { hrmsOrgId: H1 }, tEmp)).status === 403);
  s = await summaryOf(tEmp);
  check("…nor are these kinds counted for them", !group(s, "hiring") && !group(s, "salary_advance"), show(s?.groups?.map((g: any) => g.type)));

  console.log(`\n${checks - failures}/${checks} checks passed`);
  hrms.stop(true);
  await mongoose.disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  hrms.stop(true);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
