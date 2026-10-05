/**
 * Payments taken in another currency at the close (the owner, 2026-10-05:
 * "currency and conversion rate, paid amount and converted amount … reflect on
 * finance also"), over the signed HTTP the CRMs send them on, against a real
 * API process. The CRM converts each payment to the invoice's currency; finance
 * keeps what was handed over beside it, shows it, and records the converted
 * figure — with the original in the payment's note:
 *
 *   - Case 1: an INR payment and an AED one keep their originals, the
 *     approver's screen gets them, and approving records both in AED with the
 *     INR one's original in its note — paid in full;
 *   - Case 2: part paid, a corrected resend with a new rate, a currency shown
 *     in whole units, and payments with no original (unchanged);
 *   - Case 3: an original that can't be right — refused;
 *   - Case 4: unsigned calls and who may approve.
 *
 * Run through scripts/close-currency-e2e.sh (throwaway mongod and API, no
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

const PORT = process.env.E2E_API_PORT ?? "4134";
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

async function signedPost(orgId: string, p: string, payload: unknown, sign = true): Promise<Res> {
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
      "x-delta-signature": sign ? crypto.createHmac("sha256", INBOUND_SECRET).update(canonical).digest("hex") : "0".repeat(64),
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
/** INR 50,000 at 1 INR = 0.044 AED → AED 2,200 — as the CRM sends it. */
const inr = (over: Record<string, unknown> = {}) => ({
  method: "bank_transfer", amountMinor: 220_000, paidOn: "2026-10-05", receipt: receipt("inr-a"),
  original: { currency: "INR", amountMinor: 5_000_000, rate: 0.044 }, ...over,
});

async function main() {
  await mongoose.connect(uri);
  if (["finance", "finanace"].includes(mongoose.connection.db!.databaseName)) {
    console.error("Refusing to run against a database named like the real one.");
    process.exit(1);
  }

  step("Setting up");
  const org = await Organization.create({
    name: "Close Currency E2E",
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
  const body = (k: number, over: Record<string, unknown>) => ({
    externalId: `fx-${k}`, source: "crm", crm: "remote",
    customer: { name: `Client ${k}`, email: `client${k}@e2e-test.com`, phone: `+97150000${String(k).padStart(4, "0")}` },
    course: { name: "Course 1", amountMinor: 225_000 },
    modeOfStudy: "online", language: "English", salespersonEmail: "sally@e2e-test.com", salespersonName: "Sally Sales",
    ...over,
  });
  const enrol = (over: Record<string, unknown>, sign = true) => { n++; return signedPost(orgId, "/api/v1/integrations/enrolments", body(n, over), sign); };
  const idOf = (r: Res) => String(r.body?.data?.invoiceId ?? r.body?.invoiceId);
  const invoiceOf = async (r: Res) => Invoice.findById(idOf(r)).lean() as Promise<any>;
  const approve = async (r: Res, token = tApprover) => request("POST", `/invoices/${idOf(r)}/approval/approve`, undefined, token);

  step("Case 1 — AED 2,250: INR 50,000 by transfer (AED 2,200) + AED 50 cash");
  let r = await enrol({
    declaredPaidMinor: 225_000, declaredPaymentMethod: "bank_transfer", receipt: receipt("inr-a"), balanceMinor: 0,
    payments: [inr(), { method: "cash", amountMinor: 5_000, paidOn: "2026-10-05", receipt: receipt("cash-b") }],
  });
  check("taken in", r.status < 300, show(r));
  let doc = await invoiceOf(r);
  check("the invoice stays in AED", doc?.currency === "AED", doc?.currency);
  check("the INR payment keeps what was handed over: INR 50,000 at 0.044",
    JSON.stringify(doc?.enrolment?.declaredPayments?.[0]?.original) === JSON.stringify({ currency: "INR", amountMinor: 5_000_000, rate: 0.044 }), JSON.stringify(doc?.enrolment?.declaredPayments?.[0]));
  check("…the AED payment has none", doc?.enrolment?.declaredPayments?.[1]?.original === undefined, JSON.stringify(doc?.enrolment?.declaredPayments?.[1]));
  const id1 = String(doc!._id);
  let got = await request("GET", `/invoices/${id1}`, undefined, tApprover);
  check("the approver's screen gets the original with the payment", got.body?.data?.enrolment?.declaredPayments?.[0]?.original?.currency === "INR"
    && got.body.data.enrolment.declaredPayments[0].original.amountMinor === 5_000_000 && got.body.data.enrolment.declaredPayments[0].original.rate === 0.044
    && got.body.data.enrolment.declaredPayments[1].original === undefined, show(got));
  r = await approve(r);
  check("approved", r.status === 200, show(r));
  doc = await Invoice.findById(id1).lean() as any;
  check("…both payments recorded in AED, as converted", (doc?.payments ?? []).map((p: any) => `${p.method}:${p.amountMinor}`).join(",") === "bank_transfer:220000,cash:5000", JSON.stringify(doc?.payments));
  check("…the INR one's note says what was handed over", doc?.payments?.[0]?.notes === "Collected at the close — recorded on approval · paid INR 50,000 at 1 INR = 0.044 AED", doc?.payments?.[0]?.notes);
  check("…the AED one's note as before", doc?.payments?.[1]?.notes === "Collected at the close — recorded on approval", doc?.payments?.[1]?.notes);
  check("…the invoice paid in full", doc?.amountPaidMinor === 225_000 && doc?.balanceMinor === 0 && doc?.status === "paid", `${doc?.amountPaidMinor}/${doc?.balanceMinor}/${doc?.status}`);

  step("Case 2 — part paid, a corrected rate, whole units, and none at all");
  r = await enrol({ declaredPaidMinor: 220_000, declaredPaymentMethod: "bank_transfer", payments: [inr()] });
  await approve(r);
  doc = await invoiceOf(r);
  check("part paid in INR: recorded, AED 50 still due", doc?.payments?.length === 1 && doc?.balanceMinor === 5_000 && doc?.status === "partial", `${doc?.payments?.length}/${doc?.balanceMinor}/${doc?.status}`);
  const first = await enrol({ declaredPaidMinor: 220_000, declaredPaymentMethod: "bank_transfer", payments: [inr()] });
  const idFix = idOf(first);
  await request("POST", `/invoices/${idFix}/approval/return`, { reason: "Wrong rate" }, tApprover);
  const resent = await signedPost(orgId, "/api/v1/integrations/enrolments", body(n, {
    declaredPaidMinor: 225_000, declaredPaymentMethod: "bank_transfer",
    payments: [inr({ amountMinor: 225_000, original: { currency: "INR", amountMinor: 5_000_000, rate: 0.045 } })],
  }));
  check("the corrected resend is taken", resent.status < 300, show(resent));
  doc = await Invoice.findById(idFix).lean() as any;
  check("…its rate replaces the first one", doc?.enrolment?.declaredPayments?.[0]?.original?.rate === 0.045 && doc?.enrolment?.declaredPayments?.[0]?.amountMinor === 225_000, JSON.stringify(doc?.enrolment?.declaredPayments));
  r = await enrol({
    declaredPaidMinor: 224_400, declaredPaymentMethod: "cash",
    payments: [{ method: "cash", amountMinor: 224_400, original: { currency: "USD", amountMinor: 61_103, rate: 3.6725 } }],
  });
  await approve(r);
  doc = await invoiceOf(r);
  check("USD keeps its cents in the note", /paid USD 611\.03 at 1 USD = 3\.6725 AED$/.test(doc?.payments?.[0]?.notes ?? ""), doc?.payments?.[0]?.notes);
  r = await enrol({ declaredPaidMinor: 50_000, declaredPaymentMethod: "cash", payments: [{ method: "cash", amountMinor: 50_000 }] });
  await approve(r);
  doc = await invoiceOf(r);
  check("no original anywhere: stored and recorded as before", doc?.enrolment?.declaredPayments?.[0]?.original === undefined && doc?.payments?.[0]?.notes === "Collected at the close — recorded on approval", JSON.stringify(doc?.payments));

  step("Case 3 — an original that can't be right is refused");
  r = await enrol({ declaredPaidMinor: 220_000, payments: [inr({ original: { currency: "inr", amountMinor: 5_000_000, rate: 0.044 } })] });
  check("a lower-case code: 422", r.status === 422, show(r));
  r = await enrol({ declaredPaidMinor: 220_000, payments: [inr({ original: { currency: "INR", amountMinor: 5_000_000, rate: 0 } })] });
  check("a rate of nothing: 422", r.status === 422, show(r));
  r = await enrol({ declaredPaidMinor: 220_000, payments: [inr({ original: { currency: "INR", amountMinor: 0, rate: 0.044 } })] });
  check("an original of nothing: 422", r.status === 422, show(r));
  r = await enrol({ declaredPaidMinor: 220_000, payments: [inr({ original: { currency: "INR", rate: 0.044 } })] });
  check("an original with no amount: 422", r.status === 422, show(r));
  r = await enrol({ declaredPaidMinor: 225_000, payments: [inr()] });
  check("still: payments (as converted) that don't add up to what was declared: 422", r.status === 422, show(r));

  step("Case 4 — unsigned calls, and who may approve");
  r = await enrol({ declaredPaidMinor: 220_000, payments: [inr()] }, false);
  check("a call without a valid signature: 401", r.status === 401, show(r));
  r = await enrol({ declaredPaidMinor: 220_000, declaredPaymentMethod: "bank_transfer", payments: [inr()] });
  const bySales = await approve(r, tSales);
  doc = await invoiceOf(r);
  check("a salesperson can't approve: 403, nothing recorded", bySales.status === 403 && (doc?.payments ?? []).length === 0, show(bySales));
  got = await request("GET", `/invoices/${idOf(r)}`);
  check("the invoice, original and all, needs a sign-in: 401", got.status === 401, show(got));

  await mongoose.disconnect();
  console.log(`\n${checks - failures}/${checks} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
