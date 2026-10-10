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
 *   - Case 4: unsigned calls and who may approve;
 *   - Case 5: the Banglore CRM closes into the INR organisation (Bangalore) —
 *     its academy, unsaid, recorded and shown as Bangalore;
 *   - Case 6: a Sales CRM close for the Bangalore academy (2026-10-10) into the
 *     same INR organisation, in paise, cash taken in AED kept as the original.
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

  step("Case 5 — the Banglore CRM closes into an INR organisation (Bangalore)");
  {
    const blr = await Organization.create({
      name: "Bangalore E2E",
      baseCurrency: "INR",
      taxRates: [{ label: "GST 18%", code: "GST", rate: 18, isDefault: true, appliesTo: "sales" }],
    });
    const blrId = String(blr._id);
    for (const def of SYSTEM_ROLES) {
      await Role.create({ organizationId: blr._id, key: def.key, name: def.name, description: def.description, permissions: def.permissions, isSystem: true });
    }
    const bRoles = await Role.find({ organizationId: blr._id }).lean();
    const bRole = (key: string) => new Types.ObjectId(String(bRoles.find((x) => x.key === key)!._id));
    await User.create({ name: "Blr Approver", email: "blr.approver@e2e-test.com", passwordHash, status: "active", memberships: [{ organizationId: blr._id, roleId: bRole("admin"), status: "active" }] });
    await User.create({ name: "Ravi Sales", email: "ravi@e2e-test.com", passwordHash, status: "active", memberships: [{ organizationId: blr._id, roleId: bRole("salesperson"), status: "active" }] });
    const tBlr = await login("blr.approver@e2e-test.com");
    // INR 1,50,000 fee; INR 1,00,000 paid by UPI-style transfer + INR 20,000 cash, in rupees, no conversion.
    const sent = await signedPost(blrId, "/api/v1/integrations/enrolments", {
      externalId: "blr-1", source: "crm", crm: "banglore",
      customer: { name: "Blr Client", email: "blr.client@e2e-test.com", phone: "+919800000001" },
      course: { name: "Trading Course", amountMinor: 15_000_000 },
      modeOfStudy: "online", language: "Kannada", salespersonEmail: "ravi@e2e-test.com", salespersonName: "Ravi Sales",
      declaredPaidMinor: 12_000_000, declaredPaymentMethod: "bank_transfer", balanceMinor: 3_000_000,
      payments: [
        { method: "bank_transfer", amountMinor: 10_000_000, paidOn: "2026-10-09", receipt: receipt("blr-a") },
        { method: "cash", amountMinor: 2_000_000, paidOn: "2026-10-09", receipt: receipt("blr-b") },
      ],
    });
    check("taken in", sent.status < 300, show(sent));
    let d = await invoiceOf(sent);
    check("the invoice is in INR, at a rate of 1 to the organisation's own", d?.currency === "INR" && d?.exchangeRate === 1, `${d?.currency} @ ${d?.exchangeRate}`);
    check("…for the INR 1,50,000 sent, unconverted", d?.totalMinor === 15_000_000, String(d?.totalMinor));
    check("…the customer is billed in INR too", (await mongoose.connection.db!.collection("customers").findOne({ _id: d?.customerId }))?.currency === "INR");
    check("…tagged the Banglore CRM", d?.enrolment?.crm === "banglore", d?.enrolment?.crm);
    check("…its academy, unsaid, recorded as Bangalore", d?.enrolment?.academy === "bangalore", d?.enrolment?.academy);
    check("…its payments carry no conversion", (d?.enrolment?.declaredPayments ?? []).every((p: any) => p.original === undefined), JSON.stringify(d?.enrolment?.declaredPayments));
    const list = await request("GET", "/approvals/list", undefined, tBlr);
    const rowB = (list.body?.data ?? []).find((x: any) => x.id === String(d?._id));
    check("on Approvals: shown as the Banglore CRM's, in INR", rowB?.crm === "banglore" && rowB?.currency === "INR" && rowB?.feeMinor === 15_000_000 && rowB?.amountMinor === 12_000_000, JSON.stringify(rowB ?? list.body).slice(0, 300));
    check("…and the Bangalore academy's", rowB?.academy === "bangalore", JSON.stringify(rowB?.academy));
    const ok = await request("POST", `/invoices/${String(d?._id)}/approval/approve`, undefined, tBlr);
    check("approved", ok.status === 200, show(ok));
    d = await Invoice.findById(d?._id).lean() as any;
    check("…both payments recorded in INR, as sent; INR 30,000 still due",
      (d?.payments ?? []).map((p: any) => `${p.method}:${p.amountMinor}`).join(",") === "bank_transfer:10000000,cash:2000000" && d?.balanceMinor === 3_000_000 && d?.status === "partial",
      JSON.stringify({ p: d?.payments, b: d?.balanceMinor, s: d?.status }));
    const other = await request("GET", `/invoices/${String(d?._id)}`, undefined, tApprover);
    check("the AED organisation's approver cannot see it", other.status === 404 || other.status === 403, show(other));

    step("Case 6 — a Sales CRM close for the Bangalore academy, into the same INR organisation");
    // INR 1,30,000 fee (paise): INR 50,000 by transfer + AED 1,000 cash at 22.75 INR per AED (INR 22,750).
    const sales = await signedPost(blrId, "/api/v1/integrations/enrolments", {
      externalId: "sales-blr-1", source: "crm", crm: "delta", academy: "bangalore",
      customer: { name: "Sales Blr Client", email: "sales.blr.client@e2e-test.com", phone: "+919800000002" },
      course: { name: "Forex Course", amountMinor: 13_000_000 },
      modeOfStudy: "online", language: "English", salespersonEmail: "someone@sales-crm-e2e.com", salespersonName: "Sales Rep",
      declaredPaidMinor: 7_275_000, declaredPaymentMethod: "bank_transfer", balanceMinor: 5_725_000,
      bonus: { given: true, amountMinor: 20_000, currency: "USD" },
      payments: [
        { method: "bank_transfer", amountMinor: 5_000_000, paidOn: "2026-10-10", receipt: receipt("sblr-a") },
        { method: "cash", amountMinor: 2_275_000, paidOn: "2026-10-10", receipt: receipt("sblr-b"), original: { currency: "AED", amountMinor: 100_000, rate: 22.75 } },
      ],
    });
    check("taken in", sales.status < 300, show(sales));
    let s6 = await invoiceOf(sales);
    check("…an INR invoice for INR 1,30,000", s6?.currency === "INR" && s6?.totalMinor === 13_000_000, `${s6?.currency} ${s6?.totalMinor}`);
    check("…tagged the Sales CRM, for the Bangalore academy", s6?.enrolment?.crm === "delta" && s6?.enrolment?.academy === "bangalore", `${s6?.enrolment?.crm}/${s6?.enrolment?.academy}`);
    check("…the AED cash keeps what was handed over: AED 1,000 at 22.75",
      JSON.stringify(s6?.enrolment?.declaredPayments?.[1]?.original) === JSON.stringify({ currency: "AED", amountMinor: 100_000, rate: 22.75 }), JSON.stringify(s6?.enrolment?.declaredPayments?.[1]));
    check("…the bonus stays in USD", s6?.enrolment?.bonus?.currency === "USD" && s6?.enrolment?.bonus?.amountMinor === 20_000, JSON.stringify(s6?.enrolment?.bonus));
    const shown = await request("GET", `/invoices/${String(s6?._id)}`, undefined, tBlr);
    check("…the approver's screen says Sales CRM, Bangalore", shown.body?.data?.enrolment?.crm === "delta" && shown.body?.data?.enrolment?.academy === "bangalore", show(shown));
    const list6 = await request("GET", "/approvals/list", undefined, tBlr);
    const row6 = (list6.body?.data ?? []).find((x: any) => x.id === String(s6?._id));
    check("…on Approvals: the Sales CRM's, the Bangalore academy's, in INR", row6?.crm === "delta" && row6?.academy === "bangalore" && row6?.currency === "INR", JSON.stringify(row6).slice(0, 300));
    const ok6 = await request("POST", `/invoices/${String(s6?._id)}/approval/approve`, undefined, tBlr);
    check("approved", ok6.status === 200, show(ok6));
    s6 = await Invoice.findById(s6?._id).lean() as any;
    check("…both payments recorded in INR; the cash one's note says AED 1,000 at 22.75",
      (s6?.payments ?? []).map((p: any) => `${p.method}:${p.amountMinor}`).join(",") === "bank_transfer:5000000,cash:2275000"
        && /paid AED 1,000(\.00)? at 1 AED = 22\.75 INR$/.test(s6?.payments?.[1]?.notes ?? "") && s6?.balanceMinor === 5_725_000,
      JSON.stringify({ p: s6?.payments, b: s6?.balanceMinor }));
    // And a Dubai close into the AED organisation is Dubai's, as before.
    const dxb = await enrol({ academy: "dubai", declaredPaidMinor: 0 });
    const dd = await invoiceOf(dxb);
    check("a Remote CRM close for Dubai, in the AED organisation: Dubai's, in AED", dd?.enrolment?.academy === "dubai" && dd?.currency === "AED", `${dd?.enrolment?.academy} ${dd?.currency}`);
    const listD = await request("GET", "/approvals/list", undefined, tApprover);
    check("…and on Approvals as Dubai's", (listD.body?.data ?? []).find((x: any) => x.id === String(dd?._id))?.academy === "dubai");
  }

  await mongoose.disconnect();
  console.log(`\n${checks - failures}/${checks} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
