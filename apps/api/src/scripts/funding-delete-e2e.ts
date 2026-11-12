/**
 * Deleting CS Portal funding requests, both ways (the user, 2026-11-12: "in finance only the super admin and managers
 * delete the request, and it will delete from the portal it came from"; CS Portal's CS, CS Manager and Super Admin
 * delete a pending or rejected one, and finance's copy comes off with it). Against the real CS Portal backend:
 *
 *   1. Who, here: a Manager, an Administrator, a Super Admin; not an accountant (who still reads and decides), nor
 *      anybody else. A Manager reads the list but does not decide.
 *   2. A pending or rejected deposit or bonus deleted here: deleted in CS Portal too (kept whole there, finance named).
 *      Then not restorable here. A pending course upgrade: still refused (reject it). An approved one: deleted here
 *      only, as before, and restorable.
 *   3. CS Portal down: deleted here, CS Portal told once it is back. Approved there meanwhile: CS Portal keeps it,
 *      and says so; restorable here.
 *   4. Deleted in CS Portal: finance's pending copy comes off first, marked as CS Portal's doing (not restorable).
 *      Approved here a moment earlier: CS Portal is told and keeps its request.
 *   5. The old withdrawal (no deletion) still waits on a pending one.
 *
 * Run through scripts/funding-delete-e2e.sh. Scratch databases only.
 */
import mongoose, { Types } from "mongoose";
import { SYSTEM_ROLES } from "@delta/shared";
const { MongoClient, ObjectId } = mongoose.mongo;

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri) || !/e2e/.test(process.env.COMMISSION_MONGO_DB ?? "")) {
  console.error(`Refusing to run: needs scratch e2e databases on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}
const { hashPassword } = await import("../lib/password");
const { Organization } = await import("../modules/organization/organization.model");
const { Role } = await import("../modules/role/role.model");
const { User } = await import("../modules/user/user.model");
const { TetraDepositModel } = await import("../modules/tetra-deposit/tetra-deposit.model");
const { drainTetraDepositDeletions } = await import("../modules/tetra-deposit/tetra-deposit.service");

const API = `http://127.0.0.1:${process.env.E2E_API_PORT}/api/v1`;
const CS = process.env.COMMISSION_URL ?? "";
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
  const r = await fetch(url, { method, headers: { "content-type": "application/json", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

/* ── The gate finance reaches CS Portal through: it can play dead. ── */
let gateDown = false;
const gate = Bun.serve({
  port: Number(process.env.E2E_GATE_PORT),
  async fetch(req) {
    if (gateDown) return new Response("down", { status: 503 });
    const url = new URL(req.url);
    const r = await fetch(`${CS}${url.pathname}${url.search}`, { method: req.method, headers: req.headers, body: req.method === "GET" ? undefined : await req.text() });
    return new Response(await r.text(), { status: r.status, headers: { "content-type": r.headers.get("content-type") ?? "application/json" } });
  },
});

/* ── Finance: an organization, its system roles, and the people. ── */
await mongoose.connect(uri);
for (const c of await mongoose.connection.db!.listCollections().toArray()) await mongoose.connection.db!.collection(c.name).deleteMany({});
const org = await Organization.create({ _id: new Types.ObjectId(ORG_ID), name: "Delta HQ E2E", baseCurrency: "AED" });
for (const def of SYSTEM_ROLES) {
  await Role.create({ organizationId: org._id, key: def.key, name: def.name, description: def.description, permissions: def.permissions, isSystem: true });
}
const roleId = async (key: string) => (await Role.findOne({ organizationId: org._id, key }).lean())!._id;
const passwordHash = await hashPassword(PASSWORD);
const member = async (name: string, email: string, key: string, extra: Record<string, unknown> = {}) => User.create({
  name, email, passwordHash, status: "active", memberships: [{ organizationId: org._id, roleId: await roleId(key), status: "active" }], ...extra,
});
await member("Asha Accountant", "asha@e2e-fdel.test", "accountant");
await member("Mona Manager", "mona@e2e-fdel.test", "manager");
await member("Adam Admin", "adam@e2e-fdel.test", "admin");
await member("Sam Super", "sam@e2e-fdel.test", "employee", { isSuperAdmin: true });
await member("Evan Employee", "evan@e2e-fdel.test", "employee");
const login = async (email: string) => {
  const r = await http(`${API}/auth/login`, "POST", { email, password: PASSWORD });
  if (!r.body?.data?.accessToken) throw new Error(`login failed for ${email}: ${show(r)}`);
  return { authorization: `Bearer ${r.body.data.accessToken as string}` };
};
const [asha, mona, adam, sam, evan] = [await login("asha@e2e-fdel.test"), await login("mona@e2e-fdel.test"), await login("adam@e2e-fdel.test"), await login("sam@e2e-fdel.test"), await login("evan@e2e-fdel.test")];

/* ── CS Portal: a student, a Super Admin, and requests that finance has copies of. ── */
const mc = new MongoClient(process.env.COMMISSION_MONGO_URI ?? "");
await mc.connect();
const cdb = mc.db(process.env.COMMISSION_MONGO_DB);
for (const c of await cdb.listCollections().toArray()) await cdb.collection(c.name).deleteMany({});
const now = new Date().toISOString();
const csAdmin = { _id: new ObjectId(), email: "super@e2e-fdel.test", full_name: "Cs Super", app_role: "super_admin", password_hash: await Bun.password.hash(PASSWORD, { algorithm: "bcrypt", cost: 10 }), created_date: now };
await cdb.collection("users").insertOne(csAdmin as any);
const student = { _id: new ObjectId(), full_name: "Abel Student", student_code: "STU-9301", email: "abel@e2e-fdel.test", primary_mentor_id: String(csAdmin._id), status: "ACTIVE", created_date: now };
await cdb.collection("students").insertOne(student as any);
const txs = cdb.collection("funding_transactions");
const csTx = async (id: string) => (await txs.findOne({ _id: new ObjectId(id) })) as any;
const csArchived = async (id: string) => (await cdb.collection("deleted_funding_requests").findOne({ _id: new ObjectId(id) })) as any;
const finRow = async (id: unknown) => (await TetraDepositModel.findById(id).lean()) as any;

let k = 0;
/** One request in both places: CS Portal's, and finance's copy of it. */
async function both(type: string, csStatus: string, finStatus: string, extra: Record<string, unknown> = {}) {
  const id = new ObjectId();
  k++;
  await txs.insertOne({
    _id: id, type, status: csStatus, student_id: String(student._id), student_name: student.full_name, student_code: student.student_code,
    amount_usd: 100 + k, primary_mentor_id: String(csAdmin._id), requested_by_id: String(csAdmin._id), requested_at: now, created_date: now,
    finance_approval: csStatus === "PENDING" ? { state: "sent", sent_at: now, org: "delta_hq" } : { state: "decided", decision: finStatus === "approved" ? "approved" : "rejected", org: "delta_hq" },
  } as any);
  const row = await TetraDepositModel.create({
    organizationId: org._id, externalId: String(id), type, status: finStatus, amountMinor: (100 + k) * 100, currency: "USD",
    student: { name: student.full_name, code: student.student_code }, requestedAt: new Date(), requestedBy: "Cs Super", events: [],
    ...(finStatus === "rejected" ? { decision: { reason: "No receipt", decidedByName: "Asha", decidedAt: new Date() }, delivery: { state: "delivered", attempts: 1 } } : {}),
    ...(finStatus === "approved" ? { decision: { approvedAmountMinor: (100 + k) * 100, decidedByName: "Asha", decidedAt: new Date() }, delivery: { state: "delivered", attempts: 1 } } : {}),
    ...extra,
  });
  return { cs: String(id), fin: String(row._id) };
}
const del = (id: string, h: Record<string, string>, reason = "Raised twice by mistake") => http(`${API}/tetra-deposits/${id}/delete`, "POST", { reason }, h);
const restore = (id: string, h: Record<string, string>) => http(`${API}/tetra-deposits/${id}/restore`, "POST", {}, h);

step("1. Who");
const p1 = await both("BONUS", "PENDING", "pending");
let r = await del(p1.fin, asha);
check("an accountant: may not delete", r.status === 403, show(r));
r = await http(`${API}/tetra-deposits/list?status=all`, "GET", undefined, asha);
check("…still reads the list", r.status === 200, show(r));
r = await del(p1.fin, evan);
check("an employee: refused", r.status === 403, show(r));
r = await http(`${API}/tetra-deposits/list?status=all`, "GET", undefined, evan);
check("…and does not read the list", r.status === 403, show(r));
r = await http(`${API}/tetra-deposits/list?status=all`, "GET", undefined, mona);
check("a Manager reads the list", r.status === 200 && r.body.data.some((x: any) => x.id === p1.fin), show(r));
r = await http(`${API}/tetra-deposits/${p1.fin}/decision`, "POST", { decision: "approved", amountMinor: 10100, transactionId: "T1" }, mona);
check("…but does not decide", r.status === 403, show(r));

step("2. Deleted here: off CS Portal too");
r = await del(p1.fin, mona, "Duplicate of an older one");
let row = await finRow(p1.fin);
check("a Manager deletes a pending bonus: deleted, CS Portal told and done", r.status === 200 && row.status === "deleted" && row.deleted?.previousStatus === "pending"
  && row.deleted?.csPortal?.state === "done" && r.body?.data?.deleted?.csPortal?.state === "done", show(r));
check("…gone from CS Portal, kept whole there as finance's doing", !(await csTx(p1.cs)) && (await csArchived(p1.cs))?.from === "finance"
  && (await csArchived(p1.cs))?.by_name === "Mona Manager (Delta Finance)" && (await csArchived(p1.cs))?.reason === "Duplicate of an older one");
check("…its history says so", row.events.some((e: any) => e.kind === "cs_portal_deleted"), JSON.stringify(row.events));
r = await restore(p1.fin, mona);
check("…not restorable here (raised again there)", r.status === 409 && /CS Portal deletes it too/.test(r.body?.error?.message ?? ""), show(r));
r = await restore(p1.fin, asha);
check("an accountant may not restore", r.status === 403, show(r));

const r1 = await both("DEPOSIT", "REJECTED", "rejected");
r = await del(r1.fin, adam);
check("an Administrator deletes a rejected deposit: CS Portal deletes it too", r.status === 200 && (await finRow(r1.fin)).deleted?.csPortal?.state === "done" && !(await csTx(r1.cs)), show(r));
const s1 = await both("BONUS", "PENDING", "pending");
r = await del(s1.fin, sam);
check("a Super Admin too", r.status === 200 && !(await csTx(s1.cs)), show(r));

const up = await TetraDepositModel.create({ organizationId: org._id, externalId: new ObjectId().toHexString(), type: "COURSE_UPGRADE", status: "pending", amountMinor: 5000, currency: "USD", student: { name: "X", code: "STU-1" }, requestedAt: new Date(), events: [] });
r = await del(String(up._id), mona);
check("a pending course upgrade: still refused — reject it", r.status === 409 && /reject it instead/.test(r.body?.error?.message ?? ""), show(r));

const a1 = await both("BONUS", "APPROVED", "approved");
r = await del(a1.fin, mona);
row = await finRow(a1.fin);
check("an approved one: deleted here only, CS Portal not told", r.status === 200 && row.status === "deleted" && !row.deleted?.csPortal && (await csTx(a1.cs))?.status === "APPROVED", show(r));
r = await restore(a1.fin, mona);
check("…and restorable", r.status === 200 && (await finRow(a1.fin)).status === "approved", show(r));

step("3. CS Portal down, or keeping it");
gateDown = true;
const d1 = await both("BONUS", "PENDING", "pending");
r = await del(d1.fin, mona);
row = await finRow(d1.fin);
check("CS Portal down: deleted here, CS Portal to be told", r.status === 200 && row.status === "deleted" && row.deleted?.csPortal?.state === "queued" && row.deleted.csPortal.attempts === 1 && !!(await csTx(d1.cs)), show(r));
r = await restore(d1.fin, mona);
check("…not restorable while it is being told", r.status === 409, show(r));
await drainTetraDepositDeletions();
check("…the worker before it is due: nothing", (await finRow(d1.fin)).deleted?.csPortal?.attempts === 1);
gateDown = false;
await TetraDepositModel.updateOne({ _id: d1.fin }, { $set: { "deleted.csPortal.nextAttemptAt": new Date(Date.now() - 1000) } });
await drainTetraDepositDeletions();
check("…back up: the worker tells it, and it is deleted there", (await finRow(d1.fin)).deleted?.csPortal?.state === "done" && !(await csTx(d1.cs)), JSON.stringify((await finRow(d1.fin)).deleted));

const k1 = await both("BONUS", "PENDING", "pending");
await txs.updateOne({ _id: new ObjectId(k1.cs) }, { $set: { status: "APPROVED" } });
r = await del(k1.fin, mona);
row = await finRow(k1.fin);
check("approved in CS Portal meanwhile: CS Portal keeps it, and says so", r.status === 200 && row.deleted?.csPortal?.state === "kept" && /approved/.test(row.deleted.csPortal.message) && (await csTx(k1.cs))?.status === "APPROVED", show(r));
r = await restore(k1.fin, mona);
check("…so it can be restored here", r.status === 200, show(r));

step("4. Deleted in CS Portal");
const csLogin = await http(`${CS}/api/auth/login`, "POST", { email: csAdmin.email, password: PASSWORD });
const csAuth = { authorization: `Bearer ${csLogin.body?.token}` };
check("signed in to CS Portal", !!csLogin.body?.token, show(csLogin));
const c1 = await both("BONUS", "PENDING", "pending");
r = await http(`${CS}/api/functions/deleteFundingRequest`, "POST", { id: c1.cs, reason: "Wrong student" }, csAuth);
row = await finRow(c1.fin);
check("a pending bonus: finance's copy off first, then gone there", r.status === 200 && r.body?.finance === "removed" && !(await csTx(c1.cs))
  && row.status === "deleted" && row.deleted?.from === "cs_portal" && /Deleted in CS Portal by Cs Super \(CS Portal\): Wrong student/.test(row.deleted.reason), `${show(r)} ${JSON.stringify(row?.deleted)}`);
r = await restore(c1.fin, mona);
check("…not restorable here", r.status === 409 && /deleted in CS Portal/.test(r.body?.error?.message ?? ""), show(r));
const c2 = await both("BONUS", "PENDING", "approved");
r = await http(`${CS}/api/functions/deleteFundingRequest`, "POST", { id: c2.cs, reason: "Wrong" }, csAuth);
check("finance approved it a moment earlier: kept in both, CS Portal says why", r.status === 409 && /approved it already/.test(JSON.stringify(r.body))
  && (await csTx(c2.cs))?.finance_approval?.state === "sent" && (await finRow(c2.fin)).status === "approved", show(r));
const c3 = await both("DEPOSIT", "REJECTED", "rejected");
r = await http(`${CS}/api/functions/deleteFundingRequest`, "POST", { id: c3.cs, reason: "Old" }, csAuth);
const off = async () => (await finRow(c3.fin)).status === "deleted";
let gone = false;
for (let i = 0; i < 60 && !gone; i++) { gone = await off(); if (!gone) await Bun.sleep(250); }
check("a rejected one: gone there at once, finance's copy off on CS Portal's next beat", r.status === 200 && r.body?.finance === "queued" && gone
  && (await finRow(c3.fin)).deleted?.from === "cs_portal", show(r));

step("5. The old withdrawal");
const o1 = await both("BONUS", "PENDING", "pending");
const { withdrawTetraDeposit } = await import("../modules/tetra-deposit/tetra-deposit.service");
const w = await withdrawTetraDeposit(ORG_ID, { externalId: o1.cs, byName: "x", reason: "y" });
check("without deletion, a pending one still waits", w.outcome === "pending" && (await finRow(o1.fin)).status === "pending", JSON.stringify(w));

gate.stop(true);
await mc.close();
await mongoose.disconnect();
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
