/**
 * Tetra Commission deposit requests approved here, both ways over real HTTP,
 * against a real Tetra Commission process and a real finance API.
 *
 *   1. A deposit a mentor raises in Tetra Commission reaches the accountants'
 *      queue within seconds, counted in their approvals, once however often
 *      it is handed over; nobody without the permission sees it.
 *   2. Approved here — at the amount that arrived, under its transaction ID —
 *      it is approved there at once, commission credited and the student
 *      moved to Level 2. Rejected here, it is rejected there with the reason.
 *   3. A transaction ID Tetra Commission already has is refused in front of
 *      the accountant, and the request stays pending to correct.
 *   4. Tetra Commission down mid-approval: the decision is kept and delivered
 *      once it is back. Turned down in the background: shown, and reopened.
 *   5. A request gone from Tetra Commission is closed, not left waiting.
 *   6. The deposits page lists every one — by status, searched, paged, dated
 *      — with each status's count, and one deposit with its history.
 *
 * Run through scripts/tetra-deposit-e2e.sh. Scratch databases only.
 */
import crypto from "node:crypto";
import mongoose, { Types } from "mongoose";
import { SYSTEM_ROLES } from "@delta/shared";

const uri = process.env.MONGODB_URI ?? "";
const commissionUri = process.env.COMMISSION_MONGO_URI ?? "";
const commissionDb = process.env.COMMISSION_MONGO_DB ?? "";
for (const [name, value] of [["MONGODB_URI", uri], ["COMMISSION_MONGO_URI", `${commissionUri}/${commissionDb}`]]) {
  if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(value!) || !/e2e/i.test(value!)) {
    console.error(`Refusing to run: ${name} must be a scratch e2e database on 127.0.0.1, got "${value}"`);
    process.exit(1);
  }
}

const { hashPassword } = await import("../lib/password");
const { Organization } = await import("../modules/organization/organization.model");
const { Role } = await import("../modules/role/role.model");
const { User } = await import("../modules/user/user.model");
const { TetraDepositModel } = await import("../modules/tetra-deposit/tetra-deposit.model");
const { drainTetraDepositDecisions } = await import("../modules/tetra-deposit/tetra-deposit.service");

const API = `http://127.0.0.1:${process.env.E2E_API_PORT}/api/v1`;
const COMMISSION = process.env.COMMISSION_URL ?? "";
const ORG_ID = process.env.E2E_ORG_ID ?? "";
const PASSWORD = "E2ePassword1!";

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
function step(s: string) { console.log(`\n\x1b[1m${s}\x1b[0m`); }
type Res = { status: number; body: any };
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`;
async function http(url: string, method: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const r = await fetch(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function until(fn: () => Promise<boolean>, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await Bun.sleep(150);
  }
  return false;
}

/* ── The gate finance reaches Tetra Commission through: passes everything on, or plays dead. ── */
let commissionDown = false;
const gate = Bun.serve({
  port: Number(process.env.E2E_GATE_PORT),
  async fetch(req) {
    if (commissionDown) return Response.json({ success: false, error: { code: "DOWN", message: "Tetra Commission is down" } }, { status: 503 });
    const url = new URL(req.url);
    const r = await fetch(`${COMMISSION}${url.pathname}${url.search}`, { method: req.method, headers: req.headers, body: await req.text() });
    return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
  },
});

await mongoose.connect(uri);
const tc = await mongoose.createConnection(commissionUri, { dbName: commissionDb }).asPromise();
if (mongoose.connection.host !== "127.0.0.1" || tc.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
// Emptied, not dropped: both APIs made their indexes when they started.
for (const c of await mongoose.connection.db!.listCollections().toArray()) await mongoose.connection.db!.collection(c.name).deleteMany({});
for (const c of await tc.db!.listCollections().toArray()) await tc.db!.collection(c.name).deleteMany({});
const txs = tc.db!.collection("funding_transactions");

step("Setting up Delta HQ in finance, and a mentor and student in Tetra Commission");
const org = await Organization.create({ _id: new Types.ObjectId(ORG_ID), name: "Delta HQ E2E", baseCurrency: "AED" });
for (const def of SYSTEM_ROLES) {
  await Role.create({ organizationId: org._id, key: def.key, name: def.name, description: def.description, permissions: def.permissions, isSystem: true });
}
const roleId = async (key: string) => (await Role.findOne({ organizationId: org._id, key }).lean())!._id;
const passwordHash = await hashPassword(PASSWORD);
const member = async (name: string, email: string, key: string) => User.create({
  name, email, passwordHash, status: "active", memberships: [{ organizationId: org._id, roleId: await roleId(key), status: "active" }],
});
await member("Asha Accountant", "asha@e2e-deposit.test", "accountant");
await member("Evan Employee", "evan@e2e-deposit.test", "employee");
const login = async (email: string) => {
  const r = await http(`${API}/auth/login`, "POST", { email, password: PASSWORD });
  if (!r.body?.data?.accessToken) throw new Error(`login failed for ${email}: ${show(r)}`);
  return r.body.data.accessToken as string;
};
const asha = { authorization: `Bearer ${await login("asha@e2e-deposit.test")}` };
const evan = { authorization: `Bearer ${await login("evan@e2e-deposit.test")}` };
check("the Accountant role carries the new permission", (await Role.findOne({ organizationId: org._id, key: "accountant" }).lean())!.permissions.includes("tetra_deposit:approve"));

const now = new Date().toISOString();
const plan = { _id: new Types.ObjectId(), name: "E2E Plan", active: true, deposit_levels: [{ level: 1, percentage: 10 }], created_date: now };
await tc.db!.collection("commission_plans").insertOne(plan);
const mentor = {
  _id: new Types.ObjectId(), email: "meera@e2e-deposit.test", full_name: "Mentor Meera", app_role: "junior_mentor",
  // bcrypt, which is what Tetra Commission checks passwords with.
  password_hash: await Bun.password.hash(PASSWORD, { algorithm: "bcrypt", cost: 10 }), commission_plan_id: String(plan._id), created_date: now,
};
await tc.db!.collection("users").insertOne(mentor);
const student = {
  _id: new Types.ObjectId(), full_name: "Student Sam", email: "sam@e2e-deposit.test", student_code: "STU-0200",
  student_level: "LEVEL_1", status: "ACTIVE", primary_mentor_id: String(mentor._id), primary_mentor_name: mentor.full_name, created_date: now,
};
await tc.db!.collection("students").insertOne(student);
await tc.db!.collection("mt5_accounts").insertOne({ student_id: String(student._id), mt5_login: "7770001", platform: "MT5", created_date: now });
// A deposit approved long ago, under a transaction ID a new approval must not reuse.
await txs.insertOne({ type: "DEPOSIT", status: "APPROVED", student_id: "someone-else", student_name: "Earlier Client", amount_usd: 100, transaction_id: "TXN-DUP", created_date: now });
const meera = { authorization: `Bearer ${(await http(`${COMMISSION}/api/auth/login`, "POST", { email: mentor.email, password: PASSWORD })).body?.token}` };

/** A deposit as a mentor raises it in Tetra Commission. */
async function raise(amount_usd: number): Promise<string> {
  const r = await http(`${COMMISSION}/api/entities/FundingTransaction`, "POST", {
    type: "DEPOSIT", status: "PENDING", student_id: String(student._id), student_name: student.full_name, student_code: student.student_code,
    amount_usd, payment_method: "USDT", mt5_login: "7770001", screenshot_url: "https://files.e2e-deposit.test/proof.png",
    primary_mentor_id: String(mentor._id), primary_mentor_name: mentor.full_name, requested_by_id: String(mentor._id),
    requested_by_name: mentor.full_name, requested_at: new Date().toISOString(),
    initiating_mentor_id: String(mentor._id), initiating_mentor_name: mentor.full_name,
  }, meera);
  if (r.status !== 200 || !r.body?.id) throw new Error(`could not raise a deposit: ${show(r)}`);
  return String(r.body.id);
}
const inFinance = (fundingId: string) => TetraDepositModel.findOne({ externalId: fundingId }).lean() as Promise<any>;
const reachesFinance = (fundingId: string) => until(async () => !!(await inFinance(fundingId)));
const txOf = (fundingId: string) => txs.findOne({ _id: new Types.ObjectId(fundingId) }) as Promise<any>;
const waiting = async (h = asha) => http(`${API}/tetra-deposits?view=waiting`, "GET", undefined, h);
const decide = async (financeId: string, body: unknown) => http(`${API}/tetra-deposits/${financeId}/decision`, "POST", body, asha);
const approve = (financeId: string, over: Record<string, unknown> = {}) =>
  decide(financeId, { decision: "approved", amountMinor: 95000, transactionId: "TXN-2001", paymentMethod: "USDT", mt5Login: "7770001", note: "On the statement", ...over });

step("A deposit raised in Tetra Commission reaches the accountants");
const d1 = await raise(1000);
check("within seconds", await reachesFinance(d1));
let row = await inFinance(d1);
check("as raised: the student, the amount in cents of USD, the proof, the MT5 accounts",
  row?.student?.name === "Student Sam" && row.student.code === "STU-0200" && row.student.level === "LEVEL_1" && row.amountMinor === 100000
    && row.currency === "USD" && row.screenshotUrl === "https://files.e2e-deposit.test/proof.png" && row.mt5Accounts?.[0]?.login === "7770001"
    && row.requestedBy === "Mentor Meera" && row.status === "pending", JSON.stringify(row).slice(0, 400));
check("Tetra Commission knows finance has it", await until(async () => (await txOf(d1))?.finance_approval?.state === "sent")
  && (await txOf(d1))?.finance_approval?.request_id === String(row._id));
let r = await waiting();
check("in the accountant's queue", r.status === 200 && r.body?.data?.some((d: any) => d.externalId === d1), show(r));
r = await http(`${API}/approvals/summary`, "GET", undefined, asha);
const group = r.body?.data?.groups?.find((g: any) => g.type === "tetra_deposit");
check("counted in their approvals — sidebar, pop-up and page", group?.count === 1 && group.items?.[0]?.title === "Student Sam" && group.items[0].currency === "USD", show(r));
r = await waiting(evan);
check("somebody without the permission is refused the queue", r.status === 403, show(r));
r = await http(`${API}/approvals/summary`, "GET", undefined, evan);
check("and it is not counted for them", r.status === 200 && !r.body?.data?.groups?.some((g: any) => g.type === "tetra_deposit"), show(r));

step("Handed over twice, it is one request");
const signed = async (payload: unknown) => {
  const path = "/api/v1/integrations/tetra-deposits";
  const raw = JSON.stringify(payload);
  const ts = String(Date.now());
  const nonce = crypto.randomUUID();
  const canonical = ["POST", path, ts, nonce, crypto.createHash("sha256").update(raw).digest("hex")].join("\n");
  const res = await fetch(`http://127.0.0.1:${process.env.E2E_API_PORT}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json", "x-delta-client": process.env.INBOUND_CLIENT_ID!, "x-delta-timestamp": ts, "x-delta-nonce": nonce,
      "x-delta-signature": crypto.createHmac("sha256", process.env.INBOUND_INTEGRATION_SECRET!).update(canonical).digest("hex"), "x-delta-org": ORG_ID,
    },
    body: raw,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
r = await signed({ externalId: d1, amountMinor: 100000, currency: "USD", student: { name: "Student Sam" } });
check("the same id back, and still one row", r.status === 200 && r.body?.data?.id === String(row._id)
  && (await TetraDepositModel.countDocuments({ externalId: d1 })) === 1, show(r));
r = await signed({ externalId: "bad", amountMinor: 0, student: { name: "" } });
check("a malformed one is refused as such (Tetra Commission hands it back)", r.status === 422, show(r));

step("A transaction ID Tetra Commission already has is refused in front of the accountant");
r = await approve(String(row._id), { transactionId: "" });
check("approving needs a transaction ID", r.status === 422, show(r));
r = await approve(String(row._id), { transactionId: "TXN-DUP" });
check("refused, saying why", r.status === 409 && /TXN-DUP/.test(r.body?.error?.message ?? ""), show(r));
row = await inFinance(d1);
check("still pending here, to correct", row.status === "pending" && !row.decision?.decidedAt && !row.delivery?.state, JSON.stringify({ s: row.status, d: row.decision, v: row.delivery }));
check("and still pending there", (await txOf(d1))?.status === "PENDING");

step("Approved here: approved in Tetra Commission at once");
r = await approve(String(row._id));
check("delivered while the accountant waits", r.status === 200 && r.body?.data?.delivered === true && r.body.data.deposit?.status === "approved", show(r));
let t = await txOf(d1);
check("approved there at the amount that arrived, under its transaction ID", t.status === "APPROVED" && t.amount_usd === 950 && t.requested_amount_usd === 1000
  && t.transaction_id === "TXN-2001", `${t.status} ${t.amount_usd} ${t.transaction_id}`);
check("in the accountant's name", t.approved_by_name === "Asha Accountant (Delta Finance)", t.approved_by_name);
const credits = await tc.db!.collection("commission_credits").find({ transaction_id: d1 }).toArray();
check("the mentor's commission credited", credits.length === 1 && credits[0]?.commission_usd === 95, JSON.stringify(credits.map((c) => c.commission_usd)));
check("the student moved to Level 2", (await tc.db!.collection("students").findOne({ _id: student._id }))?.student_level === "LEVEL_2");
row = await inFinance(d1);
check("recorded here as delivered", row.delivery?.state === "delivered" && !!row.delivery.deliveredAt && row.decision?.transactionId === "TXN-2001");
r = await approve(String(row._id));
check("deciding it again: refused", r.status === 409, show(r));
r = await http(`${API}/approvals/summary`, "GET", undefined, asha);
check("no longer counted", (r.body?.data?.groups?.find((g: any) => g.type === "tetra_deposit")?.count ?? -1) === 0, show(r));

step("Rejected here: rejected there, with the reason");
const d2 = await raise(700);
await reachesFinance(d2);
r = await decide(String((await inFinance(d2))._id), { decision: "rejected", reason: "Nothing arrived on the statement" });
t = await txOf(d2);
check("delivered", r.status === 200 && r.body?.data?.delivered === true, show(r));
check("rejected in Tetra Commission with the accountant's reason", t.status === "REJECTED" && t.rejection_reason === "Nothing arrived on the statement", `${t.status} ${t.rejection_reason}`);
r = await decide(String((await inFinance(d2))._id), { decision: "rejected", reason: "abc" });
check("a reason is at least five characters", r.status === 422 || r.status === 409, show(r));

step("Tetra Commission down mid-approval: kept, and delivered once it is back");
const d3 = await raise(400);
await reachesFinance(d3);
commissionDown = true;
r = await approve(String((await inFinance(d3))._id), { amountMinor: 40000, transactionId: "TXN-2003" });
check("the accountant is told it is saved and will follow", r.status === 200 && r.body?.data?.delivered === false && /automatically/.test(r.body.data.message), show(r));
row = await inFinance(d3);
check("approved here, waiting to be delivered", row.status === "approved" && row.delivery?.state === "queued" && row.delivery.attempts === 1, JSON.stringify(row.delivery));
check("listed as not yet in Tetra Commission", (await http(`${API}/tetra-deposits?view=attention`, "GET", undefined, asha)).body?.data?.some((d: any) => d.externalId === d3));
check("still pending there meanwhile", (await txOf(d3))?.status === "PENDING");
commissionDown = false;
await Bun.sleep(2100);
await drainTetraDepositDecisions();
check("the worker delivers it once it is back", (await inFinance(d3))?.delivery?.state === "delivered" && (await txOf(d3))?.status === "APPROVED"
  && (await txOf(d3))?.transaction_id === "TXN-2003");

step("Turned down in the background: shown, and reopened to decide again");
const d4 = await raise(300);
await reachesFinance(d4);
const f4 = String((await inFinance(d4))._id);
commissionDown = true;
r = await approve(f4, { amountMinor: 30000, transactionId: "TXN-DUP" });
check("saved while Tetra Commission is down", r.status === 200 && r.body?.data?.delivered === false, show(r));
commissionDown = false;
await Bun.sleep(2100);
await drainTetraDepositDecisions();
row = await inFinance(d4);
check("Tetra Commission turned it down: the reason is kept", row.delivery?.state === "failed" && /TXN-DUP/.test(row.delivery.lastError ?? ""), JSON.stringify(row.delivery));
r = await http(`${API}/tetra-deposits/${f4}/reopen`, "POST", {}, asha);
check("reopened: pending again", r.status === 200 && r.body?.data?.status === "pending", show(r));
r = await approve(f4, { amountMinor: 30000, transactionId: "TXN-2004" });
check("and approved under the right ID", r.status === 200 && r.body?.data?.delivered === true && (await txOf(d4))?.status === "APPROVED", show(r));
r = await http(`${API}/tetra-deposits/${f4}/reopen`, "POST", {}, asha);
check("a delivered decision cannot be reopened", r.status === 409, show(r));

step("A request gone from Tetra Commission is closed, not left waiting");
const d5 = await raise(250);
await reachesFinance(d5);
await txs.deleteOne({ _id: new Types.ObjectId(d5) }); // as if removed there by hand
r = await approve(String((await inFinance(d5))._id), { amountMinor: 25000, transactionId: "TXN-2005" });
row = await inFinance(d5);
check("closed, with the reason", r.status === 200 && r.body?.data?.delivered === false && row.status === "closed" && /no longer/i.test(row.closedReason ?? ""), show(r));
check("and out of the queue", !(await waiting()).body?.data?.some((d: any) => d.externalId === d5));

step("The deposits page: every request, whatever became of it");
const list = (params: Record<string, string>, h = asha) => http(`${API}/tetra-deposits/list?${new URLSearchParams(params)}`, "GET", undefined, h);
r = await list({});
check("all of them, with a count of each status", r.status === 200 && r.body?.meta?.total === 5 && r.body.meta.counts?.all === 5
  && r.body.meta.counts.approved === 3 && r.body.meta.counts.rejected === 1 && r.body.meta.counts.closed === 1
  && r.body.meta.counts.pending === 0, show(r));
r = await list({ status: "approved" });
check("approved: the three, each with its transaction ID", r.body?.data?.length === 3
  && r.body.data.every((d: any) => d.status === "approved" && d.decision?.transactionId), show(r));
r = await list({ status: "rejected" });
check("rejected: the one, with the accountant's reason", r.body?.data?.length === 1
  && r.body.data[0].decision?.reason === "Nothing arrived on the statement", show(r));
r = await list({ q: "TXN-2004" });
check("found by transaction ID", r.body?.data?.length === 1 && r.body.data[0].externalId === d4, show(r));
r = await list({ q: "stu-0200" });
check("and by student code, whatever the case", r.body?.meta?.total === 5, show(r));
r = await list({ pageSize: "2", sort: "amount", dir: "asc" });
check("paged, and sorted by amount", r.body?.data?.length === 2 && r.body.meta.pageCount === 3
  && r.body.data[0].amountMinor === 25000 && r.body.data[1].amountMinor === 30000, show(r));
r = await list({ from: new Date(Date.now() + 86_400_000).toISOString() });
check("between dates: none raised tomorrow, and the counts agree", r.body?.meta?.total === 0 && r.body.meta.counts?.all === 0, show(r));
r = await list({ status: "nonsense" });
check("a status that does not exist is refused", r.status === 422, show(r));
r = await list({}, evan);
check("somebody without the permission is refused the page", r.status === 403, show(r));
r = await http(`${API}/tetra-deposits/${f4}`, "GET", undefined, asha);
const kinds = (r.body?.data?.events ?? []).map((e: any) => e.kind);
check("one deposit, with its history: approved, turned down, reopened, approved again, delivered",
  r.status === 200 && JSON.stringify(kinds) === JSON.stringify(["received", "approved", "failed", "reopened", "approved", "delivered"]), JSON.stringify(kinds));

gate.stop(true);
await tc.close();
await mongoose.disconnect();
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
