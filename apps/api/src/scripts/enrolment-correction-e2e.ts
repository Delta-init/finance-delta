/**
 * A sent-back enrolment corrected in a CRM (the user, 2026-10-05: "if send it
 * back we can edit the course and amount also, all details" — and finance takes
 * the corrected client too), over the signed HTTP the CRMs send it on, against
 * a real API process:
 *
 *   - Case 1: the client's name written again in English (the same number, a
 *     spelling fix), another course at another fee, another language — the
 *     same invoice and number, the client's own record brought up to date;
 *   - Case 2: the wrong email corrected — the invoice moves to that client,
 *     made with the name and phone sent; the wrong one is left as it was;
 *   - Case 3: corrected to the email of a client already known here — the
 *     invoice moves to them, and their own details stay as they are (flagged,
 *     the name and number sent not being theirs);
 *   - Case 4: a resend that is no correction — waiting for approval, or
 *     approved — changes nobody;
 *   - Cases 6–8, one email, one client (the user, 2026-10-10): a correction
 *     that keeps the email but is for somebody else — another number, or with
 *     no number known another name — never renames the client the email
 *     belongs to, and is flagged; given the client's own email it moves to
 *     them and the flag goes, from the answer the CRM keeps too.
 *
 * Run through scripts/enrolment-correction-e2e.sh (throwaway mongod and API, no
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
import { Customer } from "../modules/customer/customer.model";
import { Item } from "../modules/inventory/item.model";

const uri = process.env.MONGODB_URI ?? "";
if (!/127\.0\.0\.1|localhost/.test(uri) || !/e2e|test/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch database, got "${uri}"`);
  process.exit(1);
}

const PORT = process.env.E2E_API_PORT ?? "4136";
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
    name: "Enrolment Correction E2E",
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

  /** An enrolment as a CRM sends it — the same externalId for a correction. */
  const send = (externalId: string, over: Record<string, unknown>) =>
    signedPost(orgId, "/api/v1/integrations/enrolments", {
      externalId, source: "crm", crm: "delta",
      course: { name: "Course 1 - Market Breakout Theory", amountMinor: 225_000 },
      modeOfStudy: "online", language: "Malayalam", salespersonEmail: "sally@e2e-test.com", salespersonName: "Sally Sales",
      declaredPaidMinor: 225_000, declaredPaymentMethod: "cash", receipt: receipt(`${externalId}-cash`),
      ...over,
    });
  const idOf = (r: Res) => String(r.body?.data?.invoiceId ?? "");
  const invoice = (id: string) => Invoice.findById(id).lean() as Promise<any>;
  const sendBack = (id: string, reason: string) => request("POST", `/invoices/${id}/approval/return`, { reason }, tApprover);
  /** The one-email-one-client flag among an answer's or an invoice's flags. */
  const emailFlag = (flags?: string[]) => (flags ?? []).find((f) => /already belongs to/.test(f));

  step("Case 1 — the name written again in English (the same number — a spelling fix), another course and fee, another language");
  let r = await send("stu-0062", { customer: { name: "അബ്ദുൾ ഹക്കീം", email: "hakeem@e2e-test.com", phone: "+971501111111" } });
  check("taken in", r.status < 300, show(r));
  const id1 = idOf(r);
  let doc = await invoice(id1);
  const number1 = doc?.invoiceNumber;
  const client1 = String(doc?.customerId);
  r = await sendBack(id1, "please change the client name into English");
  check("sent back", r.status === 200, show(r));
  r = await send("stu-0062", {
    customer: { name: "Abdul Hakeem", email: "Hakeem@E2E-test.com", phone: "050 111 1111" },
    course: { name: "Course 2 - Advanced", amountMinor: 250_000 }, language: "English",
    declaredPaidMinor: 250_000,
  });
  check("the correction is taken: not a duplicate", r.status < 300 && r.body?.data?.duplicate === false, show(r));
  doc = await invoice(id1);
  check("the same invoice, the same number, waiting for approval again", idOf(r) === id1 && doc?.invoiceNumber === number1 && doc?.approval?.state === "pending", `${idOf(r)} ${doc?.invoiceNumber} ${doc?.approval?.state}`);
  check("…for the same client, now named in English", String(doc?.customerId) === client1 && doc?.customerName === "Abdul Hakeem", `${doc?.customerId} ${doc?.customerName}`);
  let c = await Customer.findById(client1).lean() as any;
  check("…whose own record says so too, with the number as resent", c?.name === "Abdul Hakeem" && c?.phone === "050 111 1111" && c?.email === "hakeem@e2e-test.com", JSON.stringify({ name: c?.name, phone: c?.phone, email: c?.email }));
  check("…and nothing flagged about the email: the same number is the same person", !emailFlag(r.body?.data?.flags), JSON.stringify(r.body?.data?.flags));
  check("…billed for the new course at the new fee", doc?.lineItems?.length === 1 && doc.lineItems[0].description === "Course 2 - Advanced" && doc?.totalMinor === 250_000, `${doc?.lineItems?.[0]?.description} ${doc?.totalMinor}`);
  check("…and the enrolment says the new course and language", doc?.enrolment?.course === "Course 2 - Advanced" && doc?.enrolment?.language === "English", `${doc?.enrolment?.course} / ${doc?.enrolment?.language}`);

  step("Case 2 — the wrong email corrected: the invoice moves to that client");
  r = await send("stu-0070", { customer: { name: "Riya Menon", email: "riya.wrong@e2e-test.com", phone: "+971503333333" } });
  const id2 = idOf(r);
  const wrong = String((await invoice(id2))?.customerId);
  await sendBack(id2, "The email is wrong");
  r = await send("stu-0070", { customer: { name: "Riya Menon", email: "riya@e2e-test.com", phone: "+971503333333" } });
  doc = await invoice(id2);
  c = await Customer.findById(doc?.customerId).lean() as any;
  check("the invoice is now for riya@…, a client made with the name and phone sent", r.status < 300 && String(doc?.customerId) !== wrong && c?.email === "riya@e2e-test.com" && c?.name === "Riya Menon" && c?.phone === "+971503333333", `${r.status} ${c?.email}`);
  const left = await Customer.findById(wrong).lean() as any;
  check("…and the wrong one is left as it was", left?.email === "riya.wrong@e2e-test.com" && left?.name === "Riya Menon");

  step("Case 3 — corrected to the email of a client finance already knows");
  r = await send("stu-0080", { customer: { name: "Known Client", email: "known@e2e-test.com", phone: "+971504444444" } });
  const known = String((await invoice(idOf(r)))?.customerId);
  r = await send("stu-0081", { customer: { name: "Typo Client", email: "knwon@e2e-test.com", phone: "+971505555555" } });
  const id3 = idOf(r);
  await sendBack(id3, "This is our existing client, known@");
  r = await send("stu-0081", { customer: { name: "Known Client (typed again)", email: "known@e2e-test.com", phone: "+971506666666" } });
  doc = await invoice(id3);
  c = await Customer.findById(known).lean() as any;
  check("the invoice moves to the client already known", r.status < 300 && String(doc?.customerId) === known && doc?.customerName === "Known Client", `${doc?.customerId} ${doc?.customerName}`);
  check("…whose own details stay as they are", c?.name === "Known Client" && c?.phone === "+971504444444", JSON.stringify({ name: c?.name, phone: c?.phone }));
  check("…flagged, as at a close: the name and number sent are not theirs",
    /already belongs to Known Client \(CUST-\d+\) — this close is for Known Client \(typed again\)\./.test(emailFlag(r.body?.data?.flags) ?? ""), JSON.stringify(r.body?.data?.flags));

  step("Case 4 — a resend that is no correction changes nobody");
  r = await send("stu-0090", { customer: { name: "Waiting Client", email: "waiting@e2e-test.com", phone: "+971507777777" } });
  const id4 = idOf(r);
  const waiting = String((await invoice(id4))?.customerId);
  r = await send("stu-0090", { customer: { name: "Someone Else", email: "waiting@e2e-test.com", phone: "+971500000001" } });
  c = await Customer.findById(waiting).lean() as any;
  doc = await invoice(id4);
  check("waiting for approval: a duplicate, nobody renamed", r.body?.data?.duplicate === true && c?.name === "Waiting Client" && doc?.customerName === "Waiting Client", `${r.body?.data?.duplicate} ${c?.name}`);
  r = await request("POST", `/invoices/${id4}/approval/approve`, undefined, tApprover);
  check("approved", r.status === 200, show(r));
  r = await send("stu-0090", { customer: { name: "Someone Else", email: "other@e2e-test.com", phone: "+971500000001" } });
  doc = await invoice(id4);
  c = await Customer.findById(waiting).lean() as any;
  check("approved: a duplicate, the same client, unchanged", r.body?.data?.duplicate === true && String(doc?.customerId) === waiting && c?.name === "Waiting Client", `${r.body?.data?.duplicate} ${doc?.customerId}`);

  step("Case 5 — the academy is fixed per close (2026-10-10): a correction cannot move it");
  r = await send("stu-0100", { academy: "bangalore", customer: { name: "Bangalore Client", email: "blr.client@e2e-test.com", phone: "+919800000100" } });
  const id5 = idOf(r);
  check("a close for the Bangalore academy is kept as Bangalore's", r.status < 300 && (await invoice(id5))?.enrolment?.academy === "bangalore", show(r));
  await sendBack(id5, "Fix the phone");
  r = await send("stu-0100", { academy: "dubai", customer: { name: "Bangalore Client", email: "blr.client@e2e-test.com", phone: "+919800000101" } });
  doc = await invoice(id5);
  check("…corrected naming Dubai: back with the approver, the academy still Bangalore", r.status < 300 && doc?.approval?.state === "pending" && doc?.enrolment?.academy === "bangalore",
    `${doc?.approval?.state} ${doc?.enrolment?.academy}`);
  r = await request("GET", `/invoices/${id5}`, undefined, tApprover);
  check("…and the approver is shown Bangalore", r.body?.data?.enrolment?.academy === "bangalore", show(r));

  step("Case 6 — two people closed with one email (2026-10-10): the second is filed under the first, flagged, and a correction never renames the first");
  // A mapped course, so the email is the only thing flagged and its going can be seen.
  const item = await Item.create({
    organizationId: org._id, itemNumber: "ITM-0001", name: "Course 1 - Market Breakout Theory", sku: "MBT",
    type: "service", trackStock: false, sellingPriceMinor: 225_000,
  });
  const mapped = { name: "Course 1 - Market Breakout Theory", amountMinor: 225_000, itemId: String(item._id) };
  r = await send("stu-0110", { course: mapped, customer: { name: "najad ahmed", email: "shared@e2e-test.com", phone: "+971501230001" } });
  const najad = String((await invoice(idOf(r)))?.customerId);
  check("the first person's close: no flags at all", r.status < 300 && Array.isArray(r.body?.data?.flags) && r.body.data.flags.length === 0, show(r));
  r = await send("stu-0111", { course: mapped, customer: { name: "Halif", email: "shared@e2e-test.com", phone: "+971559990002" } });
  const id6 = idOf(r);
  check("the second person's close is filed under the first, and flagged",
    r.status < 300 && String((await invoice(id6))?.customerId) === najad && r.body?.data?.flags?.length === 1 && Boolean(emailFlag(r.body?.data?.flags)), show(r));
  await sendBack(id6, "This is not najad — use Halif's own email");
  r = await send("stu-0111", { course: mapped, customer: { name: "Halif", email: "shared@e2e-test.com", phone: "+971559990002" } });
  doc = await invoice(id6);
  c = await Customer.findById(najad).lean() as any;
  check("corrected but keeping the shared email: back with the approver", r.status < 300 && r.body?.data?.duplicate === false && doc?.approval?.state === "pending", show(r));
  check("…the client the email belongs to is not renamed, and keeps their number", c?.name === "najad ahmed" && c?.phone === "+971501230001", JSON.stringify({ name: c?.name, phone: c?.phone }));
  check("…the invoice stays under them", String(doc?.customerId) === najad && doc?.customerName === "najad ahmed", `${doc?.customerId} ${doc?.customerName}`);
  check("…and it is flagged again, on the invoice and in the answer",
    /already belongs to najad ahmed \(CUST-\d+\) — this close is for Halif\./.test(emailFlag(doc?.external?.flags) ?? "") && Boolean(emailFlag(r.body?.data?.flags)),
    `${JSON.stringify(doc?.external?.flags)} / ${JSON.stringify(r.body?.data?.flags)}`);
  await sendBack(id6, "Use Halif's own email");
  r = await send("stu-0111", { course: mapped, customer: { name: "Halif", email: "halif@e2e-test.com", phone: "+971559990002" } });
  doc = await invoice(id6);
  const halif = await Customer.findById(doc?.customerId).lean() as any;
  check("corrected to Halif's own email: the invoice moves to a client of their own",
    r.status < 300 && String(doc?.customerId) !== najad && halif?.email === "halif@e2e-test.com" && halif?.name === "Halif" && doc?.customerName === "Halif",
    `${halif?.email} ${doc?.customerName}`);
  check("…and the flag is gone — from the invoice, and from the answer the CRM keeps",
    (doc?.external?.flags ?? []).length === 0 && Array.isArray(r.body?.data?.flags) && r.body.data.flags.length === 0,
    `${JSON.stringify(doc?.external?.flags)} / ${JSON.stringify(r.body?.data?.flags)}`);
  c = await Customer.findById(najad).lean() as any;
  check("…najad ahmed as they were", c?.name === "najad ahmed" && c?.phone === "+971501230001", JSON.stringify({ name: c?.name, phone: c?.phone }));

  step("Case 7 — the same email and name with another number: not written over theirs, flagged for a look");
  r = await send("stu-0120", { customer: { name: "Sara Khan", email: "sara@e2e-test.com", phone: "+971501110003" } });
  const id7 = idOf(r);
  const sara = String((await invoice(id7))?.customerId);
  await sendBack(id7, "Fix the phone");
  r = await send("stu-0120", { customer: { name: "sara khan", email: "sara@e2e-test.com", phone: "+971501110004" } });
  c = await Customer.findById(sara).lean() as any;
  const f7 = emailFlag(r.body?.data?.flags) ?? "";
  check("back with the approver, the client's name and number as they were",
    r.status < 300 && (await invoice(id7))?.approval?.state === "pending" && c?.name === "Sara Khan" && c?.phone === "+971501110003", JSON.stringify({ name: c?.name, phone: c?.phone }));
  check("…flagged, saying why, without either number", /already belongs to Sara Khan \(CUST-\d+\), with another phone number/.test(f7) && !/\d{7,}/.test(f7), f7);

  step("Case 8 — no number known for the client: the names decide");
  r = await send("stu-0130", { customer: { name: "PRIYA NAIR", email: "priya@e2e-test.com", phone: "n/a" } });
  const id8 = idOf(r);
  const priya = String((await invoice(id8))?.customerId);
  await sendBack(id8, "Add the phone, and the name in capitals is wrong");
  r = await send("stu-0130", { customer: { name: "Priya Nair", email: "priya@e2e-test.com", phone: "+971501110005" } });
  c = await Customer.findById(priya).lean() as any;
  check("the same name however written: the spelling and the number saved, nothing flagged",
    r.status < 300 && c?.name === "Priya Nair" && c?.phone === "+971501110005" && !emailFlag(r.body?.data?.flags), JSON.stringify({ name: c?.name, phone: c?.phone, flags: r.body?.data?.flags }));
  await sendBack(id8, "Check the client");
  r = await send("stu-0130", { customer: { name: "Someone Else", email: "priya@e2e-test.com", phone: "n/a" } });
  c = await Customer.findById(priya).lean() as any;
  check("another name, and no number to tell by: not renamed, flagged",
    r.status < 300 && c?.name === "Priya Nair" && c?.phone === "+971501110005"
      && /already belongs to Priya Nair \(CUST-\d+\) — this close is for Someone Else\./.test(emailFlag(r.body?.data?.flags) ?? ""),
    JSON.stringify({ name: c?.name, phone: c?.phone, flags: r.body?.data?.flags }));
  await sendBack(id8, "Check the spelling");
  r = await send("stu-0130", { customer: { name: "priya nair", email: "priya@e2e-test.com", phone: "n/a" } });
  c = await Customer.findById(priya).lean() as any;
  check("…the same name with no number: the name saved as resent, and a number that is not one never written over theirs",
    r.status < 300 && c?.name === "priya nair" && c?.phone === "+971501110005" && !emailFlag(r.body?.data?.flags), JSON.stringify({ name: c?.name, phone: c?.phone }));

  await mongoose.disconnect();
  console.log(`\n${checks - failures}/${checks} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
