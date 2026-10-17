/**
 * The sales note from a CRM close (the owner, 2026-10-17: "when any note is
 * added in the sales portal it needs to show on finance"), over the signed HTTP
 * the CRMs use, against a real API process:
 *
 *   - Case 1: a close carrying a sales note keeps it on the enrolment — never in
 *     the invoice's own notes, which are printed for the client;
 *   - Case 2: a later change in the CRM updates it through
 *     /integrations/enrolments/sales-note, whatever the approval state, and
 *     changes nothing else; a resend of an enrolment already here updates it
 *     too, and one from an older CRM that sends no note leaves it alone;
 *   - Case 3: a sent-back enrolment corrected with a new note; "" clears it;
 *   - Case 4: bad input — an unknown enrolment, another organization's, a
 *     note too long, no note at all — is refused;
 *   - Case 5: an unsigned call is refused.
 *
 * Run through scripts/sales-note-e2e.sh (throwaway mongod and API, no .env).
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

const PORT = process.env.E2E_API_PORT ?? "4152";
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
  const mkOrg = async (name: string) => {
    const org = await Organization.create({
      name, baseCurrency: "AED",
      taxRates: [{ label: "VAT 5%", code: "VAT", rate: 5, isDefault: true, appliesTo: "sales" }],
    });
    for (const def of SYSTEM_ROLES) {
      await Role.create({ organizationId: org._id, key: def.key, name: def.name, description: def.description, permissions: def.permissions, isSystem: true });
    }
    return org;
  };
  const org = await mkOrg("Sales Note E2E");
  const other = await mkOrg("Another Org E2E");
  const orgId = String(org._id);
  const roles = await Role.find({ organizationId: org._id }).lean();
  const roleId = (key: string) => new Types.ObjectId(String(roles.find((r) => r.key === key)!._id));
  const passwordHash = await hashPassword(PASSWORD);
  await User.create({ name: "Approver", email: "approver@e2e-test.com", passwordHash, status: "active", memberships: [{ organizationId: org._id, roleId: roleId("admin"), status: "active" }] });
  await User.create({ name: "Sally Sales", email: "sally@e2e-test.com", passwordHash, status: "active", memberships: [{ organizationId: org._id, roleId: roleId("salesperson"), status: "active" }] });
  const tApprover = await login("approver@e2e-test.com");

  const send = (externalId: string, over: Record<string, unknown>) =>
    signedPost(orgId, "/api/v1/integrations/enrolments", {
      externalId, source: "crm", crm: "remote",
      customer: { name: `Client ${externalId}`, email: `${externalId}@e2e-test.com`, phone: "+97150" + externalId.replace(/\D/g, "").padStart(7, "0") },
      course: { name: "Course 1 - Market Breakout Theory", amountMinor: 550_000 },
      modeOfStudy: "online", language: "English", salespersonEmail: "sally@e2e-test.com", salespersonName: "Sally Sales",
      declaredPaidMinor: 550_000, declaredPaymentMethod: "cash", receipt: receipt(`${externalId}-cash`),
      ...over,
    });
  const noteTo = (externalId: string, salesNote: unknown, o = orgId) =>
    signedPost(o, "/api/v1/integrations/enrolments/sales-note", { source: "crm", externalId, salesNote });
  const idOf = (r: Res) => String(r.body?.data?.invoiceId ?? "");
  const invoice = (id: string) => Invoice.findById(id).lean() as Promise<any>;
  const dto = async (id: string) => (await request("GET", `/invoices/${id}`, undefined, tApprover)).body?.data;

  step("Case 1 — a close with a sales note");
  const NOTE = "1500 is for one to one session, kindly review and approve. The client is UAE local — handle carefully.";
  let r = await send("stu-1001", { salesNote: NOTE });
  check("taken in", r.status < 300, show(r));
  const id1 = idOf(r);
  let doc = await invoice(id1);
  check("the note is kept on the enrolment", doc?.enrolment?.salesNote === NOTE, JSON.stringify(doc?.enrolment?.salesNote));
  check("…with when it was written", doc?.enrolment?.salesNoteUpdatedAt instanceof Date);
  check("…and NOT in the invoice's own notes, which the client's invoice prints", !doc?.notes, JSON.stringify(doc?.notes));
  let d = await dto(id1);
  check("the invoice screens get it (enrolment.salesNote)", d?.enrolment?.salesNote === NOTE && typeof d?.enrolment?.salesNoteUpdatedAt === "string", JSON.stringify(d?.enrolment?.salesNote));
  check("…while the printable notes stay empty", !d?.notes);
  r = await send("stu-1002", {});
  d = await dto(idOf(r));
  check("a close with no note has none (absent, not blank)", r.status < 300 && d?.enrolment && d.enrolment.salesNote === undefined, JSON.stringify(d?.enrolment?.salesNote));

  step("Case 2 — a later change in the CRM");
  const before = await invoice(id1);
  await new Promise((res) => setTimeout(res, 15));
  r = await noteTo("stu-1001", "  Client asked for weekend classes.  ");
  doc = await invoice(id1);
  check("updated through /enrolments/sales-note (trimmed)", r.status === 200 && doc?.enrolment?.salesNote === "Client asked for weekend classes.", show(r));
  check("…answering which invoice", r.body?.data?.invoiceNumber === before?.invoiceNumber && r.body?.data?.invoiceId === id1, show(r));
  check("…its time moves on", new Date(doc?.enrolment?.salesNoteUpdatedAt).getTime() > new Date(before?.enrolment?.salesNoteUpdatedAt).getTime());
  check("…and nothing else changed: still waiting, same total, same course", doc?.approval?.state === "pending" && doc?.totalMinor === before?.totalMinor && doc?.enrolment?.course === before?.enrolment?.course && !doc?.notes, `${doc?.approval?.state} ${doc?.totalMinor}`);
  r = await request("POST", `/invoices/${id1}/approval/approve`, {}, tApprover);
  check("approved", r.status === 200 && (await invoice(id1))?.approval?.state === "approved", show(r));
  r = await noteTo("stu-1001", "Approved — note edited afterwards.");
  doc = await invoice(id1);
  check("an approved enrolment's note still updates", r.status === 200 && doc?.enrolment?.salesNote === "Approved — note edited afterwards.", show(r));
  check("…and it stays approved", doc?.approval?.state === "approved");
  r = await send("stu-1001", { salesNote: "Changed again, carried by a resend." });
  doc = await invoice(id1);
  check("a resend of an enrolment already here is a duplicate…", r.status < 300 && r.body?.data?.duplicate === true, show(r));
  check("…that brings its note up to date", doc?.enrolment?.salesNote === "Changed again, carried by a resend." && doc?.approval?.state === "approved");
  r = await send("stu-1001", {});
  check("a resend from an older CRM, with no note, leaves it alone", (await invoice(id1))?.enrolment?.salesNote === "Changed again, carried by a resend.");

  step("Case 3 — sent back and corrected");
  r = await send("stu-1003", { salesNote: "First note" });
  const id3 = idOf(r);
  await request("POST", `/invoices/${id3}/approval/return`, { reason: "please check the fee" }, tApprover);
  r = await send("stu-1003", { salesNote: "Corrected note", course: { name: "Course 1 - Market Breakout Theory", amountMinor: 500_000 }, declaredPaidMinor: 500_000 });
  doc = await invoice(id3);
  check("the correction carries its new note", r.status < 300 && doc?.approval?.state === "pending" && doc?.enrolment?.salesNote === "Corrected note", `${doc?.approval?.state} ${doc?.enrolment?.salesNote}`);
  r = await noteTo("stu-1003", "");
  doc = await invoice(id3);
  d = await dto(id3);
  check("an empty note clears it", r.status === 200 && doc?.enrolment?.salesNote === "" && d?.enrolment?.salesNote === undefined, show(r));

  step("Case 4 — refused");
  r = await noteTo("stu-9999", "nobody");
  check("an enrolment this organization does not have → 404", r.status === 404, show(r));
  r = await noteTo("stu-1001", "wrong org", String(other._id));
  check("another organization's enrolment → 404, and untouched", r.status === 404 && (await invoice(id1))?.enrolment?.salesNote === "Changed again, carried by a resend.", show(r));
  r = await noteTo("stu-1001", "x".repeat(2001));
  check("a note over 2000 characters → 422", r.status === 422, show(r));
  r = await signedPost(orgId, "/api/v1/integrations/enrolments/sales-note", { source: "crm", externalId: "stu-1001" });
  check("no note at all → 422", r.status === 422, show(r));
  r = await send("stu-1004", { salesNote: "y".repeat(2001) });
  check("a close with a note over 2000 characters → 422, nothing made", r.status === 422 && !(await Invoice.exists({ "external.externalId": "stu-1004" })), show(r));
  const manual = await Invoice.findOne({ _id: id1 }).lean() as any;
  check("(the approved one still has its own note)", manual?.enrolment?.salesNote === "Changed again, carried by a resend.");

  step("Case 5 — unsigned");
  const plain = await fetch(`${ORIGIN}/api/v1/integrations/enrolments/sales-note`, {
    method: "POST", headers: { "content-type": "application/json", "x-delta-org": orgId },
    body: JSON.stringify({ source: "crm", externalId: "stu-1001", salesNote: "sneaky" }),
  });
  check("an unsigned call is refused (401)", plain.status === 401, String(plain.status));
  check("…and changed nothing", (await invoice(id1))?.enrolment?.salesNote === "Changed again, carried by a resend.");

  console.log(`\n${checks - failures}/${checks} checks passed`);
  await mongoose.disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
