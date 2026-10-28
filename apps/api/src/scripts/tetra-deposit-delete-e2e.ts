/**
 * Deleting a CS Portal deposit by hand, and restoring it (the user, 2026-10-28: "a delete option in Tetra
 * deposits"), through the API:
 *
 *   - Who: the people who decide them; a reason is needed.
 *   - An approved one: kept as "deleted", with who, why and what it was; off the list and its counts; under Deleted;
 *     its invoice no longer held by it. Restored: as it was.
 *   - Refused: one waiting for a decision (reject it), one still on its way to CS Portal, one whose payment is
 *     still on an invoice (named) — allowed once that invoice is void.
 *
 * The rows are put with finance directly (as they stand once decided). Run through scripts/tetra-deposit-delete-e2e.sh.
 * Scratch databases only.
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
const { TetraDepositModel } = await import("../modules/tetra-deposit/tetra-deposit.model");

const API = `http://127.0.0.1:${process.env.E2E_API_PORT}/api/v1`;
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

await mongoose.connect(uri);
for (const c of await mongoose.connection.db!.listCollections().toArray()) await mongoose.connection.db!.collection(c.name).deleteMany({});
const org = await Organization.create({ _id: new Types.ObjectId(ORG_ID), name: "Delta HQ E2E", baseCurrency: "AED" });
for (const def of SYSTEM_ROLES) {
  await Role.create({ organizationId: org._id, key: def.key, name: def.name, description: def.description, permissions: def.permissions, isSystem: true });
}
const roleId = async (key: string) => (await Role.findOne({ organizationId: org._id, key }).lean())!._id;
const passwordHash = await hashPassword(PASSWORD);
const member = async (name: string, email: string, key: string) => User.create({
  name, email, passwordHash, status: "active", memberships: [{ organizationId: org._id, roleId: await roleId(key), status: "active" }],
});
await member("Asha Accountant", "asha@e2e-delete.test", "accountant");
await member("Evan Employee", "evan@e2e-delete.test", "employee");
const login = async (email: string) => {
  const r = await http(`${API}/auth/login`, "POST", { email, password: PASSWORD });
  if (!r.body?.data?.accessToken) throw new Error(`login failed for ${email}: ${show(r)}`);
  return r.body.data.accessToken as string;
};
const asha = { authorization: `Bearer ${await login("asha@e2e-delete.test")}` };
const evan = { authorization: `Bearer ${await login("evan@e2e-delete.test")}` };

const invoices = mongoose.connection.db!.collection("invoices");
const paymentId = new Types.ObjectId();
const invoiceId = new Types.ObjectId();
await invoices.insertOne({ _id: invoiceId, organizationId: org._id, invoiceNumber: "IN-00900", status: "partially_paid", currency: "AED", totalMinor: 1200000, payments: [{ _id: paymentId, amountMinor: 1000000 }] });
const base = (n: string, extra: Record<string, unknown>) => ({
  organizationId: org._id, externalId: `ext-${n}`, type: "BONUS", amountMinor: 272480, currency: "USD",
  student: { name: `Student ${n}`, code: `STU-${n}` }, requestedAt: new Date(), requestedBy: "Alice Antony", events: [], ...extra,
});
const decided = { decision: { approvedAmountMinor: 272480, transactionId: "42", decidedByName: "super admin", decidedAt: new Date() } };
const approved = await TetraDepositModel.create(base("1", { status: "approved", ...decided, delivery: { state: "delivered", attempts: 1 } }));
const pending = await TetraDepositModel.create(base("2", { status: "pending" }));
const sending = await TetraDepositModel.create(base("3", { status: "approved", ...decided, delivery: { state: "queued", attempts: 1, nextAttemptAt: new Date(Date.now() + 3600e3) } }));
const holding = await TetraDepositModel.create(base("4", { status: "approved", ...decided, delivery: { state: "delivered", attempts: 1 },
  courseInvoice: { invoiceId, invoiceNumber: "IN-00900", paymentId: String(paymentId), receiptNumber: "RCT-00900", amountMinor: 1000000, currency: "AED", created: true } }));
const del = (id: unknown, body: unknown, h = asha) => http(`${API}/tetra-deposits/${id}/delete`, "POST", body, h);

step("Who, and why");
let r = await del(approved._id, { reason: "Wrong amount — sent again" }, evan);
check("somebody who doesn't decide them: refused", r.status === 403, show(r));
r = await del(approved._id, { reason: "x" });
check("no reason: refused", r.status === 422, show(r));

step("An approved one");
r = await del(approved._id, { reason: "Wrong amount — sent again" });
let row: any = await TetraDepositModel.findById(approved._id).lean();
check("deleted — kept, with who, when, why and what it was", r.status === 200 && row.status === "deleted" && row.deleted?.previousStatus === "approved"
  && row.deleted.reason === "Wrong amount — sent again" && row.deleted.byName === "Asha Accountant" && !!row.deleted.at && row.events.at(-1)?.kind === "deleted", show(r));
check("…what the page gets says so", r.body?.data?.status === "deleted" && r.body.data.deleted?.byName === "Asha Accountant", show(r));
r = await http(`${API}/tetra-deposits/list?status=all&pageSize=100`, "GET", undefined, asha);
check("off the list (All) and its count", r.status === 200 && !r.body.data.some((x: any) => x.id === String(approved._id)) && r.body.meta.counts.all === 3 && r.body.meta.counts.deleted === 1 && r.body.meta.counts.approved === 2, show(r));
r = await http(`${API}/tetra-deposits/list?status=deleted`, "GET", undefined, asha);
check("under Deleted", r.status === 200 && r.body.data.length === 1 && r.body.data[0].deleted?.reason === "Wrong amount — sent again", show(r));
r = await http(`${API}/tetra-deposits?view=decided`, "GET", undefined, asha);
check("not among the latest decisions on Approvals", r.status === 200 && !r.body.data.some((x: any) => x.id === String(approved._id)), show(r));
r = await del(approved._id, { reason: "Again please" });
check("deleting it again: said so", r.status === 409, show(r));
r = await http(`${API}/tetra-deposits/${approved._id}/restore`, "POST", {}, evan);
check("restoring — somebody who doesn't decide them: refused", r.status === 403, show(r));
r = await http(`${API}/tetra-deposits/${approved._id}/restore`, "POST", {}, asha);
row = await TetraDepositModel.findById(approved._id).lean();
check("restored: approved again, the delete only in its history", r.status === 200 && row.status === "approved" && !row.deleted && row.events.at(-1)?.kind === "restored", show(r));
r = await http(`${API}/tetra-deposits/${approved._id}/restore`, "POST", {}, asha);
check("restoring one not deleted: said so", r.status === 409, show(r));

step("Refused");
r = await del(pending._id, { reason: "Not wanted" });
check("waiting for a decision: refused — reject it instead", r.status === 409 && /reject it instead/.test(r.body?.error?.message ?? ""), show(r));
r = await del(sending._id, { reason: "Wrong" });
check("its decision still on its way to CS Portal: refused", r.status === 409 && /on its way/.test(r.body?.error?.message ?? ""), show(r));
r = await del(holding._id, { reason: "Wrong course" });
check("its payment still on an invoice: refused, naming the receipt and invoice", r.status === 409 && /RCT-00900 is still on invoice IN-00900/.test(r.body?.error?.message ?? ""), show(r));
check("…nothing changed", (await TetraDepositModel.findById(holding._id).lean() as any).status === "approved");
await invoices.updateOne({ _id: invoiceId }, { $set: { status: "void" } });
r = await del(holding._id, { reason: "Wrong course — invoice voided" });
check("once that invoice is void: deleted", r.status === 200 && r.body?.data?.status === "deleted", show(r));
r = await del("not-an-id", { reason: "Whatever" });
check("no such one: 404", r.status === 404, show(r));

await mongoose.disconnect();
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
