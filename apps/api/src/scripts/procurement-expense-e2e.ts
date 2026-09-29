/**
 * Drives the Procurement page's API — GET /procurement, approve, reject —
 * against the real finance API and the real HRMS API.
 *
 * What it proves:
 *   - approving a purchase request records an expense, approved and unpaid,
 *     with no vendor and no purchase order — amount, category and department
 *     as the approver chose, HR's details in its notes — and HRMS hears
 *     "approved" with the expense number, which office keeping's WhatsApp
 *     now carries without calling it a PO;
 *   - the department is suggested from the payroll department links;
 *   - an approval of nothing, or with an unknown category or somebody else's
 *     department, records nothing and tells HRMS nothing;
 *   - if HRMS cannot be told, the expense stands and the request stays
 *     waiting, marked with it; approving again resends it and makes no other,
 *     and rejecting it is refused until the expense is voided;
 *   - two approvers at once make one expense;
 *   - a request revised and sent back after a rejection is a new decision;
 *   - only `expense:approve` decides them — `po:create` no longer does — and
 *     another organization cannot reach them.
 *
 * Run through scripts/procurement-expense-e2e.sh (throwaway mongod, both
 * APIs, no .env anywhere).
 */
import fs from "node:fs";
import http from "node:http";
import mongoose, { Types } from "mongoose";
import { SYSTEM_ROLES } from "@delta/shared";
import { hashPassword } from "../lib/password";
import { Organization } from "../modules/organization/organization.model";
import { Role } from "../modules/role/role.model";
import { User } from "../modules/user/user.model";
import { Department } from "../modules/department/department.model";
import { Expense } from "../modules/expense/expense.model";
import { PayrollOrgLink } from "../modules/payroll-mapping/org-link.model";
import { PayrollDeptLink } from "../modules/payroll-mapping/dept-link.model";

const uri = process.env.MONGODB_URI ?? "";
const hrmsUri = process.env.E2E_HRMS_DB ?? "";
for (const [name, value] of [["MONGODB_URI", uri], ["E2E_HRMS_DB", hrmsUri]] as const) {
  if (!/^mongodb:\/\/127\.0\.0\.1:\d+\/[^/?]*e2e/.test(value)) {
    console.error(`Refusing to run: ${name} must be a scratch e2e database on 127.0.0.1, got "${value}"`);
    process.exit(1);
  }
}
const BASE = `http://127.0.0.1:${process.env.E2E_API_PORT ?? "4143"}/api/v1`;
const HRMS_ORIGIN = `http://127.0.0.1:${process.env.E2E_HRMS_PORT ?? "5093"}`;
const PROXY_PORT = Number(process.env.E2E_PROXY_PORT ?? "5094");
const HRMS_LOG = process.env.E2E_HRMS_LOG ?? "";
const PASSWORD = "E2ePassword1!";

let failures = 0;
let checks = 0;
function check(label: string, condition: boolean, detail = "") {
  checks++;
  if (condition) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
function step(name: string) { console.log(`\n\x1b[1m${name}\x1b[0m`); }
const show = (v: unknown) => JSON.stringify(v).slice(0, 300);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

/**
 * Finance's way to HRMS. Passes everything through untouched — the signature
 * covers method, path and body, none of which change — unless told to fail
 * the approve call, which is how HRMS going down half-way is staged.
 */
const proxyState = { failApprove: false };
const proxy = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (proxyState.failApprove && req.method === "POST" && /\/procurement\/requests\/[^/?]+\/approve/.test(req.url ?? "")) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: false, message: "HRMS is down (e2e)" }));
    return;
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || ["host", "connection", "content-length"].includes(k)) continue;
    headers[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  try {
    const r = await fetch(`${HRMS_ORIGIN}${req.url}`, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
    });
    res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (err) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: false, message: (err as Error).message }));
  }
});

/** What HRMS logged it would have sent on WhatsApp — it is not configured, so it logs instead. */
function whatsAppLines(): string[] {
  return fs.readFileSync(HRMS_LOG, "utf8").split("\n").filter((l) => l.includes("[dry-run] WhatsApp"));
}
async function waitForWhatsApp(fragment: string): Promise<string | undefined> {
  for (let i = 0; i < 25; i++) {
    const hit = whatsAppLines().find((l) => l.includes(fragment));
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 200));
  }
  return undefined;
}

async function main() {
  await new Promise<void>((resolve) => proxy.listen(PROXY_PORT, "127.0.0.1", resolve));
  // The API builds the collections and their indexes, as it does in production.
  // This process loads the same models, and two processes building the same
  // indexes on a fresh database at once can leave some unbuilt — among them the
  // unique key this test is about.
  mongoose.set("autoIndex", false);
  mongoose.set("autoCreate", false);
  await mongoose.connect(uri);
  if (mongoose.connection.host !== "127.0.0.1" || !/e2e/.test(mongoose.connection.db!.databaseName)) {
    console.error(`Refusing to run: connected to ${mongoose.connection.host}/${mongoose.connection.db!.databaseName}`);
    process.exit(1);
  }
  const hrms = await mongoose.createConnection(hrmsUri).asPromise();
  if (hrms.host !== "127.0.0.1" || !/e2e/.test(hrms.db!.databaseName)) {
    console.error(`Refusing to run: HRMS connection is ${hrms.host}/${hrms.db!.databaseName}`);
    process.exit(1);
  }
  const H = (name: string) => hrms.db!.collection(name);

  step("HRMS: an organisation, a requester, office keeping, and requests HR has approved");
  const hOrg = new Types.ObjectId();
  const hIt = new Types.ObjectId();
  const hOps = new Types.ObjectId();
  const hRequester = new Types.ObjectId();
  const hFacilities = new Types.ObjectId();
  const hProcRole = new Types.ObjectId();
  const now = new Date();
  await H("organizations").insertOne({ _id: hOrg, name: "Delta HRMS E2E", createdAt: now, updatedAt: now });
  await H("departments").insertMany([
    { _id: hIt, name: "IT DEPARTMENT", organization: hOrg, createdAt: now, updatedAt: now },
    { _id: hOps, name: "Operations", organization: hOrg, createdAt: now, updatedAt: now },
  ]);
  await H("roles").insertOne({ _id: hProcRole, roleName: "Procurement approver", organization: hOrg, isSystemRole: false, permissions: { procurement: { view: true, approve: true } }, createdAt: now, updatedAt: now });
  await H("users").insertMany([
    { _id: hRequester, name: "Riya Requester", email: "riya@hrms-e2e.test", organization: hOrg, status: "active", createdAt: now, updatedAt: now },
    { _id: hFacilities, name: "Faisal Facilities", email: "faisal@hrms-e2e.test", organization: hOrg, role: hProcRole, status: "active", createdAt: now, updatedAt: now },
  ]);
  await H("employees").insertOne({ user: hFacilities, organization: hOrg, name: "Faisal Facilities", mobileNumber: "0501234567", createdAt: now, updatedAt: now });

  const req = (item: string, extra: Record<string, unknown> = {}) => ({
    _id: new Types.ObjectId(), organization: hOrg, kind: "new", item, category: "IT", quantity: 1, estimatedCost: 100,
    currency: "AED", vendor: "", department: null, requestedBy: hRequester, neededBy: null, justification: "",
    status: "hr_approved", hrReviewedAt: now, hrNote: "", financeReviewedAt: null, financeNote: "",
    purchaseOrderRef: "", rejectedBy: null, resubmitCount: 0, createdAt: now, updatedAt: now, ...extra,
  });
  const laptop = req("Laptop", { quantity: 2, estimatedCost: 3200, department: hIt, neededBy: new Date("2026-10-15T00:00:00Z"), justification: "Two developers start in October", vendor: "Sharaf DG", hrNote: "OK from HR" });
  const chair = req("Office chair", { estimatedCost: 0, department: hOps, category: "furniture" });
  const printer = req("Printer", { estimatedCost: 800, department: hIt });
  const lamp = req("Desk lamp", { quantity: 3, estimatedCost: 150 });
  const monitor = req("Monitor", { estimatedCost: 900 });
  const toner = req("Toner", { quantity: 4, estimatedCost: 400 });
  const desk = req("Standing desk", { estimatedCost: 1500, department: hIt });
  const notYet = req("Whiteboard", { status: "requested" });
  await H("procurements").insertMany([laptop, chair, printer, lamp, monitor, toner, desk, notYet]);
  const hrmsRow = async (id: Types.ObjectId) => H("procurements").findOne({ _id: id });

  step("Finance: two organizations, the HRMS link, and who decides what");
  const org = await Organization.create({ name: "Procurement E2E", baseCurrency: "AED" });
  const other = await Organization.create({ name: "Somebody Else", baseCurrency: "AED" });
  for (const o of [org, other]) {
    for (const def of SYSTEM_ROLES) {
      await Role.create({ organizationId: o._id, key: def.key, name: def.name, description: def.description, permissions: def.permissions, isSystem: true });
    }
  }
  const systemRole = async (o: Types.ObjectId, key: string) => (await Role.findOne({ organizationId: o, key }).lean())!._id;
  const purchaserRole = await Role.create({ organizationId: org._id, key: "purchaser", name: "Purchaser", description: "", permissions: ["po:read", "po:create"], isSystem: false });
  const spendRole = await Role.create({ organizationId: org._id, key: "spend-approver", name: "Spend approver", description: "", permissions: ["expense:approve", "expense:read"], isSystem: false });
  const it = await Department.create({ organizationId: org._id, name: "IT DEPARTMENT" });
  const ops = await Department.create({ organizationId: org._id, name: "Operations" });
  const elsewhere = await Department.create({ organizationId: other._id, name: "Elsewhere" });
  const passwordHash = await hashPassword(PASSWORD);
  const mk = (o: Types.ObjectId, name: string, email: string, role: Types.ObjectId) =>
    User.create({ name, email, passwordHash, status: "active", memberships: [{ organizationId: o, roleId: role, departmentId: o.equals(org._id) ? it._id : elsewhere._id, status: "active" }] });
  const admin = await mk(org._id, "Ada Admin", "admin@procurement-e2e.test", await systemRole(org._id, "admin"));
  await mk(org._id, "Pat Purchaser", "purchaser@procurement-e2e.test", purchaserRole._id);
  const spender = await mk(org._id, "Sam Spend", "spend@procurement-e2e.test", spendRole._id);
  await mk(other._id, "Olly Other", "other@procurement-e2e.test", await systemRole(other._id, "admin"));
  await PayrollOrgLink.create({ organizationId: org._id, hrmsOrgId: String(hOrg), hrmsOrgName: "Delta HRMS E2E", isActive: true });
  await PayrollDeptLink.create({ organizationId: org._id, hrmsOrgId: String(hOrg), hrmsDepartmentId: String(hIt), hrmsDepartmentName: "IT DEPARTMENT", departmentId: it._id });

  const tAdmin = await login("admin@procurement-e2e.test");
  const tPurchaser = await login("purchaser@procurement-e2e.test");
  const tSpend = await login("spend@procurement-e2e.test");
  const tOther = await login("other@procurement-e2e.test");
  const H1 = String(hOrg);
  const approve = (id: Types.ObjectId | string, body: Record<string, unknown>, token = tAdmin) =>
    request("POST", `/procurement/${String(id)}/approve`, { hrmsOrgId: H1, ...body }, token);
  const reject = (id: Types.ObjectId | string, body: Record<string, unknown> = {}, token = tAdmin) =>
    request("POST", `/procurement/${String(id)}/reject`, { hrmsOrgId: H1, ...body }, token);
  const expensesFor = (id: Types.ObjectId) => Expense.find({ "source.requestId": String(id) }).lean();
  const list = async (token = tAdmin) => request("GET", "/procurement", undefined, token);
  const rowOf = (res: Res, id: Types.ObjectId) => (res.body?.data ?? []).find((r: { _id: string }) => r._id === String(id));
  const procurementCount = async (token = tAdmin) =>
    ((await request("GET", "/approvals/summary", undefined, token)).body?.data?.groups ?? []).find((g: { type: string }) => g.type === "procurement")?.count;

  // ── Case 1: happy path ────────────────────────────────────────────────────
  step("Case 1 — the list, and approving one as an expense");
  const first = await list();
  check("the list answers", first.status === 200, show(first.body));
  check("every request HR approved is there, and nothing HR has not", (first.body?.data ?? []).length === 7 && !rowOf(first, notYet._id), show((first.body?.data ?? []).map((r: { item: string }) => r.item)));
  check("the laptop's department is suggested from the payroll links", rowOf(first, laptop._id)?.suggestedDepartmentId === String(it._id), show(rowOf(first, laptop._id)));
  check("an unlinked HR department suggests none, a same-named finance one notwithstanding", rowOf(first, chair._id)?.suggestedDepartmentId === null && ops.name === rowOf(first, chair._id)?.department?.name, show(rowOf(first, chair._id)));
  check("nothing has an expense yet", (first.body?.data ?? []).every((r: { expense: unknown }) => r.expense === null));
  const countBefore = await procurementCount();
  check("the approvals summary counts them", countBefore === 7, String(countBefore));

  const ok1 = await approve(laptop._id, { amountMinor: 3500_00, category: "other", categoryOther: "IT equipment", departmentId: String(it._id), note: "Buy from Sharaf DG" });
  check("approving answers 200 with the expense", ok1.status === 200 && /^EXP-\d+$/.test(ok1.body?.data?.expense?.expenseNumber ?? ""), show(ok1.body));
  const laptopNo = ok1.body?.data?.expense?.expenseNumber as string;
  const [lx] = await expensesFor(laptop._id);
  check("one expense, approved", (await expensesFor(laptop._id)).length === 1 && lx?.status === "approved", show(lx));
  check("at the amount the approver chose", lx?.amountMinor === 3500_00 && lx?.totalMinor === 3500_00 && lx?.taxMinor === 0 && lx?.currency === "AED");
  check("in the chosen category, named as typed", lx?.category === "other" && lx?.categoryName === "IT equipment", `${lx?.category} / ${lx?.categoryName}`);
  check("against the chosen department", String(lx?.departmentId) === String(it._id));
  check("described as what was asked for", lx?.description === "2 × Laptop", lx?.description);
  check("approved and submitted by the approver", String(lx?.approvedById) === String(admin._id) && lx?.approvedByName === "Ada Admin" && String(lx?.submittedById) === String(admin._id) && !!lx?.approvedAt);
  check("unpaid, and due when HR needs it", !lx?.paidOn && lx?.dueDate?.toISOString().slice(0, 10) === "2026-10-15", String(lx?.dueDate));
  check("with HR's details in the notes", ["Asked by: Riya Requester", "HRMS department: IT DEPARTMENT", "Why: Two developers start in October", "Suggested vendor: Sharaf DG", "HR's estimate: AED 3200.00", "HR note: OK from HR", "Finance note: Buy from Sharaf DG"].every((s) => lx?.notes?.includes(s)), lx?.notes ?? "");
  check("linked to the request, and marked delivered", lx?.source?.kind === "hrms_procurement" && lx?.source?.requestId === String(laptop._id) && lx?.source?.round === 0 && !!lx?.source?.deliveredAt, show(lx?.source));
  const hLaptop = await hrmsRow(laptop._id);
  check("HRMS has it approved, with the expense number and the note", hLaptop?.status === "approved" && hLaptop?.purchaseOrderRef === laptopNo && hLaptop?.financeNote === "Buy from Sharaf DG" && !!hLaptop?.financeReviewedAt, show(hLaptop));
  const wa = await waitForWhatsApp(`2 × Laptop (${laptopNo})`);
  check("office keeping's WhatsApp carries the expense number", !!wa && wa.includes("Ready to purchase"), wa ?? whatsAppLines().join(" | "));
  check("and no longer calls it a PO", whatsAppLines().every((l) => !l.includes("(PO ")), whatsAppLines().join(" | "));
  check("it has left the list", !rowOf(await list(), laptop._id));
  check("and the approvals count", (await procurementCount()) === 6);
  const exp = await request("GET", "/expenses?limit=50", undefined, tAdmin);
  const listed = (exp.body?.data ?? []).find((e: { expenseNumber: string }) => e.expenseNumber === laptopNo);
  check("it is on the Expenses list, approved and unpaid", listed?.status === "approved" && listed?.paymentStatus === "unpaid", show(listed));
  const today = new Date().toISOString().slice(0, 10);
  check("dated today, as a day — the way a typed-in expense is", lx?.expenseDate?.toISOString() === `${today}T00:00:00.000Z`, String(lx?.expenseDate?.toISOString()));
  const todays = await request("GET", `/expenses?dateFrom=${today}&dateTo=${today}&limit=50`, undefined, tAdmin);
  check("so a filter on today finds it", (todays.body?.data ?? []).some((e: { expenseNumber: string }) => e.expenseNumber === laptopNo), show(todays.body?.data?.map((e: { expenseNumber: string }) => e.expenseNumber)));
  const again = await approve(laptop._id, { amountMinor: 3500_00, category: "other" });
  check("approving it again finds nothing waiting", again.status === 404, show(again.body));
  check("and makes no second expense", (await expensesFor(laptop._id)).length === 1);

  const no = await reject(lamp._id, { note: "Not this quarter" });
  check("rejecting answers 200", no.status === 200, show(no.body));
  const hLamp = await hrmsRow(lamp._id);
  check("HRMS has it rejected by finance, with the note", hLamp?.status === "rejected" && hLamp?.rejectedBy === "finance" && hLamp?.financeNote === "Not this quarter", show(hLamp));
  check("and no expense is made", (await expensesFor(lamp._id)).length === 0);

  // ── Case 2: edges ─────────────────────────────────────────────────────────
  step("Case 2 — no estimate, no department, HRMS down half-way, two at once, a second round");
  const zero = await approve(chair._id, { amountMinor: 0, category: "rent" });
  check("an amount of 0 is refused", zero.status === 422, show(zero.body));
  const none = await approve(chair._id, { category: "rent" });
  check("so is no amount at all", none.status === 422 && /amount/i.test(none.body?.error?.message ?? none.body?.message ?? ""), show(none.body));
  check("and neither recorded anything or told HRMS", (await expensesFor(chair._id)).length === 0 && (await hrmsRow(chair._id))?.status === "hr_approved");
  const chairOk = await approve(chair._id, { amountMinor: 450_00, category: "rent", departmentId: "" });
  const [cx] = await expensesFor(chair._id);
  check("with an amount, no department is fine", chairOk.status === 200 && !cx?.departmentId && cx?.categoryName === "Rent" && !cx?.dueDate, show(cx));

  proxyState.failApprove = true;
  const down = await approve(printer._id, { amountMinor: 800_00, category: "other", categoryOther: "Printer" });
  const px = await expensesFor(printer._id);
  const printerNo = px[0]?.expenseNumber;
  check("HRMS down: the approval says the expense was recorded but HR not told", down.status === 503 && !!printerNo && String(down.body?.error?.message ?? down.body?.message ?? "").includes(printerNo), show(down.body));
  check("the expense stands, undelivered", px.length === 1 && px[0]?.status === "approved" && !px[0]?.source?.deliveredAt);
  check("and HRMS still has it waiting", (await hrmsRow(printer._id))?.status === "hr_approved");
  const marked = rowOf(await list(), printer._id);
  check("the list marks the request with it", marked?.expense?.expenseNumber === printerNo && marked?.expense?.status === "approved", show(marked));
  const refused = await reject(printer._id, { note: "changed my mind" });
  check("rejecting it is refused while the expense stands", refused.status === 409 && (await hrmsRow(printer._id))?.status === "hr_approved", show(refused.body));
  proxyState.failApprove = false;
  const resend = await approve(printer._id, {});
  check("approving again resends it", resend.status === 200 && resend.body?.data?.expense?.expenseNumber === printerNo, show(resend.body));
  const px2 = await expensesFor(printer._id);
  check("no second expense, the first as it was, now delivered", px2.length === 1 && px2[0]?.totalMinor === 800_00 && !!px2[0]?.source?.deliveredAt);
  const hPrinter = await hrmsRow(printer._id);
  check("HRMS has it approved with that number", hPrinter?.status === "approved" && hPrinter?.purchaseOrderRef === printerNo, show(hPrinter));

  const keyIndex = (await Expense.collection.indexes()).find((i) => i.name === "source.key_1");
  check("the API built the unique key on the request link", keyIndex?.unique === true, JSON.stringify(keyIndex));
  const [a, b] = await Promise.all([
    approve(monitor._id, { amountMinor: 900_00, category: "other", categoryOther: "Screens" }),
    approve(monitor._id, { amountMinor: 900_00, category: "other", categoryOther: "Screens" }, tSpend),
  ]);
  const mx = await expensesFor(monitor._id);
  check("two approvers at once make one expense", mx.length === 1, `${mx.length} expenses; ${a.status} ${show(a.body)} / ${b.status} ${show(b.body)}`);
  check("at least one of them is told it worked", a.status === 200 || b.status === 200, `${a.status} / ${b.status}`);
  check("HRMS has it approved with that one", (await hrmsRow(monitor._id))?.purchaseOrderRef === mx[0]?.expenseNumber);

  proxyState.failApprove = true;
  await approve(toner._id, { amountMinor: 400_00, category: "other", categoryOther: "Supplies" });
  proxyState.failApprove = false;
  const [tx] = await expensesFor(toner._id);
  const voided = await request("POST", `/expenses/${tx?._id}/void`, {}, tAdmin);
  check("an undelivered expense can be voided", voided.status === 200, show(voided.body));
  const afterVoid = await approve(toner._id, {});
  check("approving then is refused, pointing at the voided expense", afterVoid.status === 409 && String(afterVoid.body?.error?.message ?? afterVoid.body?.message ?? "").includes(String(tx?.expenseNumber)), show(afterVoid.body));
  check("the list shows it voided", rowOf(await list(), toner._id)?.expense?.status === "voided");
  const tonerNo = await reject(toner._id, { note: "Voided — send it again with the right quantity" });
  check("and rejecting it is allowed", tonerNo.status === 200 && (await hrmsRow(toner._id))?.status === "rejected", show(tonerNo.body));
  // HR revises it and sends it round again; HR approves it again.
  await H("procurements").updateOne({ _id: toner._id }, {
    $set: { status: "hr_approved", rejectedBy: null, financeReviewedAt: null, financeNote: "", quantity: 6 },
    $inc: { resubmitCount: 1 },
  });
  const round2 = rowOf(await list(), toner._id);
  check("back for a second round, it carries no expense", round2 && round2.expense === null && round2.resubmitCount === 1, show(round2));
  const tonerOk = await approve(toner._id, { amountMinor: 600_00, category: "other", categoryOther: "Supplies" });
  const tAll = await expensesFor(toner._id);
  const t2 = tAll.find((e) => e.source?.round === 1);
  check("approving it records a new expense for the new round", tonerOk.status === 200 && tAll.length === 2 && t2?.status === "approved" && t2?.description === "6 × Toner", show(tAll.map((e) => [e.expenseNumber, e.status, e.source?.round])));

  // ── Case 3: bad input ─────────────────────────────────────────────────────
  step("Case 3 — bad input records nothing and tells HRMS nothing");
  const bad = async (label: string, res: Res, status: number) => {
    check(`${label} → ${status}`, res.status === status, `${res.status} ${show(res.body)}`);
  };
  await bad("an unknown category", await approve(desk._id, { amountMinor: 1500_00, category: "no-such-category" }), 422);
  await bad("another organization's department", await approve(desk._id, { amountMinor: 1500_00, category: "other", departmentId: String(elsewhere._id) }), 422);
  await bad("a department id that is not one", await approve(desk._id, { amountMinor: 1500_00, category: "other", departmentId: "abc" }), 422);
  await bad("a negative amount", await approve(desk._id, { amountMinor: -5, category: "other" }), 422);
  await bad("a fraction of a minor unit", await approve(desk._id, { amountMinor: 100.5, category: "other" }), 422);
  await bad("no category", await approve(desk._id, { amountMinor: 1500_00 }), 422);
  await bad("no HRMS organisation", await request("POST", `/procurement/${desk._id}/approve`, { amountMinor: 1500_00, category: "other" }, tAdmin), 422);
  await bad("an HRMS organisation not linked here", await approve(desk._id, { hrmsOrgId: String(new Types.ObjectId()), amountMinor: 1500_00, category: "other" }), 403);
  await bad("a request that does not exist", await approve(new Types.ObjectId(), { amountMinor: 1500_00, category: "other" }), 404);
  await bad("rejecting one that does not exist", await reject(new Types.ObjectId()), 404);
  check("none of it recorded anything", (await expensesFor(desk._id)).length === 0);
  check("or told HRMS anything", (await hrmsRow(desk._id))?.status === "hr_approved");

  // ── Case 4: who may ───────────────────────────────────────────────────────
  step("Case 4 — expense:approve decides; po:create no longer does; nobody else's");
  await bad("no token", await request("GET", "/procurement"), 401);
  await bad("no token, approving", await request("POST", `/procurement/${desk._id}/approve`, { hrmsOrgId: H1, amountMinor: 1500_00, category: "other" }), 401);
  await bad("po:create alone cannot see them", await list(tPurchaser), 403);
  await bad("…or approve", await approve(desk._id, { amountMinor: 1500_00, category: "other" }, tPurchaser), 403);
  await bad("…or reject", await reject(desk._id, {}, tPurchaser), 403);
  check("…and has no purchase requests in its approvals", (await procurementCount(tPurchaser)) === undefined);
  const spendList = await list(tSpend);
  check("expense:approve alone sees them", spendList.status === 200 && !!rowOf(spendList, desk._id), `${spendList.status}`);
  check("…and counts them in its approvals", typeof (await procurementCount(tSpend)) === "number");
  const otherList = await list(tOther);
  check("another organization sees none of them", otherList.status === 200 && (otherList.body?.data ?? []).length === 0, show(otherList.body));
  await bad("…and cannot approve one", await approve(desk._id, { amountMinor: 1500_00, category: "other" }, tOther), 403);
  const deskOk = await approve(desk._id, { amountMinor: 1500_00, category: "other", categoryOther: "Furniture", departmentId: String(it._id) }, tSpend);
  const [dx] = await expensesFor(desk._id);
  check("the spend approver can approve one, and is the one recorded", deskOk.status === 200 && String(dx?.approvedById) === String(spender._id) && dx?.approvedByName === "Sam Spend", show(deskOk.body));

  console.log(`\n${checks - failures}/${checks} checks passed`);
  await hrms.close();
  await mongoose.disconnect();
  proxy.close();
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  proxy.close();
  process.exit(1);
});
