/**
 * Payments taken more than one way at the close (the user, 2026-10-05: "total
 * 500, paid 300 cash and 200 card … two receipts"), over the signed HTTP the
 * CRMs send them on, against a real API process:
 *
 *   - Case 1: an enrolment with two payments keeps each, with its own method
 *     and receipt, attaches both receipts, and approving it records both
 *     against the invoice — paid in full;
 *   - Case 2: part paid, a CRM that sends only a total, nothing paid, and a
 *     corrected resend that changes the payments;
 *   - Case 3: payments that don't add up, a zero, an unknown method, too many —
 *     refused;
 *   - Case 4: what approval leaves for accounts — more than the invoice, an EMI,
 *     something already recorded — and who may approve.
 *
 * Run through scripts/split-payments-e2e.sh (throwaway mongod and API, no
 * .env). Refuses to run against anything that does not look like a scratch
 * database.
 */
import crypto from "node:crypto";
import mongoose, { Types } from "mongoose";
import { SYSTEM_ROLES } from "@delta/shared";
import { hashPassword } from "../lib/password";
import { Organization } from "../modules/organization/organization.model";
import { Role } from "../modules/role/role.model";
import { User } from "../modules/user/user.model";
import { Invoice } from "../modules/invoice/invoice.model";

const uri = process.env.MONGODB_URI ?? "";
if (!/127\.0\.0\.1|localhost/.test(uri) || !/e2e|test/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch database, got "${uri}"`);
  process.exit(1);
}

const PORT = process.env.E2E_API_PORT ?? "4133";
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BASE = `${ORIGIN}/api/v1`;
const INBOUND_ID = process.env.INBOUND_CLIENT_ID ?? "";
const INBOUND_SECRET = process.env.INBOUND_INTEGRATION_SECRET ?? "";
if (!INBOUND_ID || !INBOUND_SECRET) {
  console.error("Refusing to run: INBOUND_CLIENT_ID and INBOUND_INTEGRATION_SECRET must be set");
  process.exit(1);
}

const PASSWORD = "E2ePassword1!";

let failures = 0;
let checks = 0;
function check(label: string, condition: boolean, detail = "") {
  checks++;
  if (condition) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
function step(name: string) { console.log(`\n\x1b[1m${name}\x1b[0m`); }

type Res = { status: number; body: Record<string, any> };
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`;

async function signedPost(orgId: string, p: string, payload: unknown): Promise<Res> {
  const raw = JSON.stringify(payload);
  const ts = String(Date.now());
  const nonce = crypto.randomUUID();
  const canonical = ["POST", p, ts, nonce, crypto.createHash("sha256").update(raw).digest("hex")].join("\n");
  const r = await fetch(`${ORIGIN}${p}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-delta-client": INBOUND_ID,
      "x-delta-timestamp": ts,
      "x-delta-nonce": nonce,
      "x-delta-signature": crypto.createHmac("sha256", INBOUND_SECRET).update(canonical).digest("hex"),
      "x-delta-org": orgId,
    },
    body: raw,
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
}

async function request(method: string, p: string, body?: unknown, token?: string): Promise<Res> {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
}

async function login(email: string): Promise<string> {
  const r = await request("POST", "/auth/login", { email, password: PASSWORD });
  const token = r.body?.data?.accessToken as string | undefined;
  if (!token) throw new Error(`login failed for ${email}: ${show(r)}`);
  return token;
}

const receipt = (name: string) => ({ name: `${name}.jpg`, url: `https://files.e2e-test.com/receipts/${name}.jpg`, key: `receipts/${name}.jpg`, size: 1000, mimeType: "image/jpeg" });

async function main() {
  await mongoose.connect(uri);
  if (["finance", "finanace"].includes(mongoose.connection.db!.databaseName)) {
    console.error("Refusing to run against a database named like the real one.");
    process.exit(1);
  }

  step("Setting up");
  const org = await Organization.create({
    name: "Split Payments E2E",
    baseCurrency: "AED",
    taxRates: [{ label: "VAT 5%", code: "VAT", rate: 5, isDefault: true, appliesTo: "sales" }],
  });
  const orgId = String(org._id);
  for (const def of SYSTEM_ROLES) {
    await Role.create({ organizationId: org._id, key: def.key, name: def.name, description: def.description, permissions: def.permissions, isSystem: true });
  }
  const roles = await Role.find({ organizationId: org._id }).lean();
  const roleId = (key: string) => new Types.ObjectId(String(roles.find((r) => r.key === key)!._id));
  const passwordHash = await hashPassword(PASSWORD);
  await User.create({ name: "Approver", email: "approver@e2e-test.com", passwordHash, status: "active", memberships: [{ organizationId: org._id, roleId: roleId("admin"), status: "active" }] });
  await User.create({ name: "Sally Sales", email: "sally@e2e-test.com", passwordHash, status: "active", memberships: [{ organizationId: org._id, roleId: roleId("salesperson"), status: "active" }] });
  const tApprover = await login("approver@e2e-test.com");
  const tSales = await login("sally@e2e-test.com");

  let n = 0;
  const enrol = (over: Record<string, unknown>) => {
    n++;
    return signedPost(orgId, "/api/v1/integrations/enrolments", {
      externalId: `split-${n}`, source: "crm", crm: "remote",
      customer: { name: `Client ${n}`, email: `client${n}@e2e-test.com`, phone: `+97150000${String(n).padStart(4, "0")}` },
      course: { name: "Course 1", amountMinor: 50_000 },
      modeOfStudy: "online", language: "English", salespersonEmail: "sally@e2e-test.com", salespersonName: "Sally Sales",
      ...over,
    });
  };
  const invoiceOf = async (r: Res) => Invoice.findById(String(r.body?.data?.invoiceId ?? r.body?.invoiceId)).lean() as Promise<any>;
  const approve = async (r: Res, token = tApprover) => request("POST", `/invoices/${String(r.body?.data?.invoiceId ?? r.body?.invoiceId)}/approval/approve`, undefined, token);

  step("Case 1 — 500 paid as 300 cash and 200 card, each with its receipt");
  const cashCard = [
    { method: "cash", amountMinor: 30_000, paidOn: "2026-10-05", receipt: receipt("cash-a") },
    { method: "card", amountMinor: 20_000, paidOn: "2026-10-05", receipt: receipt("card-b") },
  ];
  let r = await enrol({ declaredPaidMinor: 50_000, declaredPaymentMethod: "cash", receipt: receipt("cash-a"), balanceMinor: 0, payments: cashCard });
  check("taken in", r.status < 300, show(r));
  let doc = await invoiceOf(r);
  check("both payments kept on the enrolment, method and amount each",
    doc?.enrolment?.declaredPayments?.map((p: any) => `${p.method}:${p.amountMinor}`).join(",") === "cash:30000,card:20000", JSON.stringify(doc?.enrolment?.declaredPayments));
  check("…with their own receipts", doc?.enrolment?.declaredPayments?.[1]?.receipt?.key === "receipts/card-b.jpg");
  check("both receipts attached to the invoice, once each", (doc?.attachments ?? []).map((a: any) => a.key).sort().join(",") === "receipts/card-b.jpg,receipts/cash-a.jpg", JSON.stringify(doc?.attachments));
  const id1 = String(doc!._id);
  let got = await request("GET", `/invoices/${id1}`, undefined, tApprover);
  check("the approver's screen gets each payment and its receipt", got.body?.data?.enrolment?.declaredPayments?.length === 2
    && got.body.data.enrolment.declaredPayments[0].receipt?.url === receipt("cash-a").url, show(got));
  r = await approve(r);
  check("approved", r.status === 200, show(r));
  doc = await Invoice.findById(id1).lean() as any;
  check("…and both payments recorded against the invoice", (doc?.payments ?? []).map((p: any) => `${p.method}:${p.amountMinor}`).join(",") === "cash:30000,card:20000", JSON.stringify(doc?.payments));
  check("…each with its own receipt as proof", doc?.payments?.[0]?.proofKey === "receipts/cash-a.jpg" && doc?.payments?.[1]?.proofKey === "receipts/card-b.jpg");
  check("…dated as declared", new Date(doc?.payments?.[0]?.paidOn).toISOString().startsWith("2026-10-05"));
  check("…the invoice paid in full", doc?.amountPaidMinor === 50_000 && doc?.balanceMinor === 0 && doc?.status === "paid", `${doc?.amountPaidMinor}/${doc?.balanceMinor}/${doc?.status}`);
  check("…and the enrolment says they were recorded", doc?.enrolment?.declaredPaymentsOnApproval?.state === "recorded");

  step("Case 2 — part paid, a total only, nothing paid, and a corrected resend");
  r = await enrol({ course: { name: "Course 2", amountMinor: 100_000 }, declaredPaidMinor: 50_000, declaredPaymentMethod: "cash", payments: cashCard });
  await approve(r);
  doc = await invoiceOf(r);
  check("part paid: both recorded, the rest still due", doc?.payments?.length === 2 && doc?.balanceMinor === 50_000 && doc?.status === "partial", `${doc?.payments?.length}/${doc?.balanceMinor}/${doc?.status}`);
  r = await enrol({ declaredPaidMinor: 40_000, declaredPaymentMethod: "bank_transfer", receipt: receipt("transfer-c") });
  doc = await invoiceOf(r);
  check("a CRM that sends only the total: no list kept", !doc?.enrolment?.declaredPayments?.length);
  await approve(r);
  doc = await invoiceOf(r);
  check("…and approving records that one payment, with its receipt", doc?.payments?.length === 1 && doc.payments[0].method === "bank_transfer"
    && doc.payments[0].amountMinor === 40_000 && doc.payments[0].proofKey === "receipts/transfer-c.jpg", JSON.stringify(doc?.payments));
  r = await enrol({ declaredPaidMinor: 0 });
  await approve(r);
  doc = await invoiceOf(r);
  check("nothing paid: nothing recorded, nothing to say", (doc?.payments ?? []).length === 0 && !doc?.enrolment?.declaredPaymentsOnApproval);
  const first = await enrol({ declaredPaidMinor: 50_000, declaredPaymentMethod: "cash", receipt: receipt("cash-d"), payments: [{ method: "cash", amountMinor: 50_000, receipt: receipt("cash-d") }] });
  const id5 = String(first.body?.data?.invoiceId ?? first.body?.invoiceId);
  const returned = await request("POST", `/invoices/${id5}/approval/return`, { reason: "Card slip missing" }, tApprover);
  check("sent back", returned.status === 200, show(returned));
  const resent = await signedPost(orgId, "/api/v1/integrations/enrolments", {
    externalId: `split-${n}`, source: "crm", crm: "remote",
    customer: { name: `Client ${n}`, email: `client${n}@e2e-test.com`, phone: `+97150000${String(n).padStart(4, "0")}` },
    course: { name: "Course 1", amountMinor: 50_000 },
    modeOfStudy: "online", language: "English", salespersonEmail: "sally@e2e-test.com", salespersonName: "Sally Sales",
    declaredPaidMinor: 50_000, declaredPaymentMethod: "cash", receipt: receipt("cash-d"),
    payments: [
      { method: "cash", amountMinor: 20_000, receipt: receipt("cash-d") },
      { method: "card", amountMinor: 20_000, receipt: receipt("card-e") },
      { method: "tabby", amountMinor: 10_000, receipt: receipt("tabby-f") },
    ],
  });
  check("the corrected resend is taken", resent.status < 300, show(resent));
  doc = await Invoice.findById(id5).lean() as any;
  check("…its payments replace the first ones", doc?.enrolment?.declaredPayments?.map((p: any) => p.method).join(",") === "cash,card,tabby" && doc?.approval?.state === "pending", JSON.stringify(doc?.enrolment?.declaredPayments));
  check("…and the new receipts join the one already attached", (doc?.attachments ?? []).map((a: any) => a.key).sort().join(",") === "receipts/card-e.jpg,receipts/cash-d.jpg,receipts/tabby-f.jpg", JSON.stringify((doc?.attachments ?? []).map((a: any) => a.key)));
  await request("POST", `/invoices/${id5}/approval/approve`, undefined, tApprover);
  doc = await Invoice.findById(id5).lean() as any;
  check("…approving records all three", doc?.payments?.length === 3 && doc?.status === "paid", `${doc?.payments?.length}/${doc?.status}`);

  step("Case 3 — payments that can't be right are refused");
  r = await enrol({ declaredPaidMinor: 50_000, payments: [{ method: "cash", amountMinor: 30_000 }, { method: "card", amountMinor: 10_000 }] });
  check("not adding up to what was declared: 422", r.status === 422, show(r));
  r = await enrol({ declaredPaidMinor: 30_000, payments: [{ method: "cash", amountMinor: 30_000 }, { method: "card", amountMinor: 0 }] });
  check("a payment of nothing: 422", r.status === 422, show(r));
  r = await enrol({ declaredPaidMinor: 30_000, payments: [{ method: "gold bars", amountMinor: 30_000 }] });
  check("a method finance doesn't know: 422", r.status === 422, show(r));
  r = await enrol({ declaredPaidMinor: 1_100, payments: Array.from({ length: 11 }, () => ({ method: "cash", amountMinor: 100 })) });
  check("more than ten payments: 422", r.status === 422, show(r));
  r = await enrol({ declaredPaidMinor: 30_000, payments: [] });
  check("an empty list: 422", r.status === 422, show(r));

  step("Case 4 — what approval leaves for accounts, and who may approve");
  r = await enrol({ declaredPaidMinor: 70_000, declaredPaymentMethod: "cash" });
  const over = await approve(r);
  doc = await invoiceOf(r);
  check("more declared than the invoice: approved, nothing recorded, and it says why", over.status === 200 && (doc?.payments ?? []).length === 0
    && doc?.enrolment?.declaredPaymentsOnApproval?.state === "skipped" && /more than the invoice/.test(doc.enrolment.declaredPaymentsOnApproval.reason ?? ""), JSON.stringify(doc?.enrolment?.declaredPaymentsOnApproval));
  r = await enrol({ declaredPaidMinor: 50_000, declaredPaymentMethod: "cash", payments: [{ method: "cash", amountMinor: 20_000 }, { method: "easebuzz_emi", amountMinor: 30_000 }] });
  await approve(r);
  doc = await invoiceOf(r);
  check("an EMI among them: left for accounts", (doc?.payments ?? []).length === 0 && /EMI/.test(doc?.enrolment?.declaredPaymentsOnApproval?.reason ?? ""), JSON.stringify(doc?.enrolment?.declaredPaymentsOnApproval));
  r = await enrol({ declaredPaidMinor: 50_000, declaredPaymentMethod: "cash", payments: cashCard });
  const idLegacy = String(r.body?.data?.invoiceId ?? r.body?.invoiceId);
  await Invoice.updateOne({ _id: idLegacy }, { $push: { payments: { method: "cash", amountMinor: 10_000, paidOn: new Date() } }, $set: { amountPaidMinor: 10_000, balanceMinor: 40_000 } });
  await approve(r);
  doc = await Invoice.findById(idLegacy).lean() as any;
  check("something recorded already: nothing added on top", doc?.payments?.length === 1 && /already recorded/.test(doc?.enrolment?.declaredPaymentsOnApproval?.reason ?? ""), JSON.stringify(doc?.enrolment?.declaredPaymentsOnApproval));
  r = await enrol({ declaredPaidMinor: 50_000, declaredPaymentMethod: "cash", payments: cashCard });
  const bySales = await approve(r, tSales);
  doc = await invoiceOf(r);
  check("a salesperson can't approve: 403, and nothing recorded", bySales.status === 403 && (doc?.payments ?? []).length === 0, show(bySales));
  const twice = await approve(r);
  const again = await approve(r);
  doc = await invoiceOf(r);
  check("approving twice: the second is refused, the payments recorded once", twice.status === 200 && again.status >= 400 && doc?.payments?.length === 2, `${twice.status}/${again.status}/${doc?.payments?.length}`);

  await mongoose.disconnect();
  console.log(`\n${checks - failures}/${checks} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
