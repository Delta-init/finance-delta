/**
 * Approvals → "Didn't go through", Send again, and an optional transaction ID (the user, 2026-10-25), end to end:
 * finance and the real CS Portal, through a gate that can play dead or turn a decision down.
 *
 *   1. The transaction ID is optional: approved here and there without one.
 *   2. One CS Portal already has is accepted there, with a note of which request shares it.
 *   3. Turned down while the accountant waits: put back in front of them, as before.
 *   4. Turned down in the background: under "Didn't go through" (counted on every tab), out of Approved; Send again
 *      delivers it and moves it to Approved; a delivered one can't be sent again; Reopen still works.
 *
 * Deposits stopped going to finance on their own on 2026-10-10 (only bonuses do), so each request is put with finance
 * here directly and handed over the way CS Portal hands one over (signed). Run through
 * scripts/approvals-failed-e2e.sh. Scratch databases only.
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

/* ── The gate finance reaches CS Portal through: passes everything on, plays dead, or turns a decision down. ── */
let commissionDown = false;
let commissionRefuses = false;
const gate = Bun.serve({
  port: Number(process.env.E2E_GATE_PORT),
  async fetch(req) {
    if (commissionDown) return Response.json({ success: false, error: { code: "DOWN", message: "CS Portal is down" } }, { status: 503 });
    if (commissionRefuses) return Response.json({ success: false, error: { code: "CONFLICT", message: "Refused for the test" } }, { status: 409 });
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

step("Setting up Delta HQ in finance, and a mentor and student in CS Portal");
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
  // bcrypt, which is what CS Portal checks passwords with.
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

/** A deposit as a mentor raises it in CS Portal. */
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

/** A deposit with finance, as one sent before 2026-10-10 is: raised in CS Portal, handed to finance. */
async function withFinance(amount_usd: number): Promise<{ fundingId: string; financeId: string }> {
  const fundingId = await raise(amount_usd);
  await txs.updateOne({ _id: new Types.ObjectId(fundingId) }, { $set: { finance_approval: { state: "sent", queued_at: now, sent_at: now, attempts: 1 } } });
  const r = await signed({ externalId: fundingId, amountMinor: amount_usd * 100, currency: "USD", student: { name: student.full_name, code: student.student_code } });
  if (r.status !== 200 && r.status !== 201) throw new Error(`could not hand it to finance: ${show(r)}`);
  const row = await inFinance(fundingId);
  await txs.updateOne({ _id: new Types.ObjectId(fundingId) }, { $set: { "finance_approval.request_id": String(row._id) } });
  return { fundingId, financeId: String(row._id) };
}
const tab = async (status: string) => (await http(`${API}/approvals/list?status=${status}&pageSize=100`, "GET", undefined, asha)).body;

step("1. The transaction ID is optional");
const a = await withFinance(210);
let r = await approve(a.financeId, { amountMinor: 21000, transactionId: "" });
let t = await txOf(a.fundingId);
check("approved without one, here and there", r.status === 200 && r.body?.data?.delivered === true && t?.status === "APPROVED", show(r));
check("…no transaction ID made up on either side", !t?.transaction_id && !(await inFinance(a.fundingId))?.decision?.transactionId);
check("…its history doesn't name one", (await inFinance(a.fundingId))?.events?.some((e: any) => e.kind === "approved" && !/transaction/.test(e.text)));

step("2. A transaction ID CS Portal already has: approved there, with a note");
const b = await withFinance(220);
r = await approve(b.financeId, { amountMinor: 22000, transactionId: "TXN-DUP" });
t = await txOf(b.fundingId);
check("delivered and approved, not turned down", r.status === 200 && r.body?.data?.delivered === true && t?.status === "APPROVED" && t.transaction_id === "TXN-DUP", show(r));
check("…saying which request shares it", t?.transaction_id_shared_with?.student_name === "Earlier Client" && /Same transaction ID as another request/.test(t?.finance_approval?.note ?? ""),
  JSON.stringify([t?.transaction_id_shared_with, t?.finance_approval?.note]));

step("3. Turned down while the accountant waits: back in front of them");
const c = await withFinance(230);
commissionRefuses = true;
r = await approve(c.financeId, { amountMinor: 23000 });
commissionRefuses = false;
check("refused, saying why", r.status === 409 && /Refused for the test/.test(r.body?.error?.message ?? ""), show(r));
check("…pending here again, and not under Didn't go through", (await inFinance(c.fundingId))?.status === "pending" && !(await tab("failed"))?.data?.some((x: any) => x.id === c.financeId));

step("4. Turned down in the background: Didn't go through, then Send again");
const d = await withFinance(240);
commissionDown = true;
r = await approve(d.financeId, { amountMinor: 24000, transactionId: "TXN-4004" });
commissionDown = false;
check("saved while CS Portal is down", r.status === 200 && r.body?.data?.delivered === false, show(r));
commissionRefuses = true;
await Bun.sleep(2100);
await drainTetraDepositDecisions();
commissionRefuses = false;
check("then turned down: kept with the reason", (await inFinance(d.fundingId))?.delivery?.state === "failed" && /Refused for the test/.test((await inFinance(d.fundingId))?.delivery?.lastError ?? ""));
let L = await tab("failed");
check("listed under Didn't go through, with the reason", L?.data?.some((x: any) => x.id === d.financeId && /Refused for the test/.test(x.delivery?.error ?? "")), JSON.stringify(L?.data?.map((x: any) => x.id)));
check("…counted: 1", L?.meta?.failed === 1, JSON.stringify(L?.meta));
check("…and only Tetra deposits are there", (L?.data ?? []).every((x: any) => x.type === "tetra_deposit"));
L = await tab("approved");
check("not under Approved; the ones that went through are", !L?.data?.some((x: any) => x.id === d.financeId) && L?.data?.some((x: any) => x.id === a.financeId) && L?.data?.some((x: any) => x.id === b.financeId));
check("…the count is the same on every tab", L?.meta?.failed === 1 && (await tab("pending"))?.meta?.failed === 1 && (await tab("all"))?.meta?.failed === 1);
check("…and All still shows it", (await tab("all"))?.data?.some((x: any) => x.id === d.financeId));
r = await http(`${API}/tetra-deposits/${d.financeId}/resend`, "POST", {}, evan);
check("somebody without the permission can't send it again", r.status === 403, show(r));
r = await http(`${API}/tetra-deposits/${d.financeId}/resend`, "POST", {}, asha);
t = await txOf(d.fundingId);
check("Send again: delivered, approved there", r.status === 200 && r.body?.data?.delivered === true && t?.status === "APPROVED" && t.transaction_id === "TXN-4004", show(r));
check("…out of Didn't go through, into Approved, count 0", !(await tab("failed"))?.data?.some((x: any) => x.id === d.financeId)
  && (await tab("approved"))?.data?.some((x: any) => x.id === d.financeId) && (await tab("approved"))?.meta?.failed === 0);
check("…its history says it was sent again", (await inFinance(d.fundingId))?.events?.some((e: any) => e.kind === "resent"));
r = await http(`${API}/tetra-deposits/${d.financeId}/resend`, "POST", {}, asha);
check("a delivered decision can't be sent again", r.status === 409, show(r));

step("Send again, turned down again: stays under Didn't go through; Reopen still works");
const e = await withFinance(250);
commissionDown = true;
await approve(e.financeId, { amountMinor: 25000 });
commissionDown = false;
commissionRefuses = true;
await Bun.sleep(2100);
await drainTetraDepositDecisions();
r = await http(`${API}/tetra-deposits/${e.financeId}/resend`, "POST", {}, asha);
commissionRefuses = false;
check("not delivered, and said so", r.status === 200 && r.body?.data?.delivered === false && /Refused for the test/.test(r.body?.data?.message ?? ""), show(r));
check("…still under Didn't go through", (await tab("failed"))?.data?.some((x: any) => x.id === e.financeId));
r = await http(`${API}/tetra-deposits/${e.financeId}/reopen`, "POST", {}, asha);
check("Reopen: pending again, out of Didn't go through", r.status === 200 && r.body?.data?.status === "pending" && !(await tab("failed"))?.data?.some((x: any) => x.id === e.financeId), show(r));

gate.stop(true);
await tc.close();
await mongoose.disconnect();
console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures ? 1 : 0);
