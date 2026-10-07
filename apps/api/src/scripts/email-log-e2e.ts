/**
 * The email log end to end (the user, 2026-10-07), over the real API with a
 * stand-in mail server:
 *   - approving an enrolment emails the client the invoice and the
 *     salesperson a copy, both in the log against the invoice;
 *   - Resend is logged with who pressed it; a refused address is "Failed",
 *     a client with no email "No email address";
 *   - a draft typed in finance is not emailed by its approval;
 *   - the log page is for admins and accountants, the invoice's own list for
 *     whoever may see the invoice.
 * Run by scripts/email-log-e2e.sh.
 */
import crypto from "node:crypto";
import mongoose, { Types } from "mongoose";
import { SYSTEM_ROLES } from "@delta/shared";
import { hashPassword } from "../lib/password";
import { Organization } from "../modules/organization/organization.model";
import { Role } from "../modules/role/role.model";
import { User } from "../modules/user/user.model";
import { Invoice } from "../modules/invoice/invoice.model";
import net from "node:net";

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


// ── A stand-in mail server: takes every message, refuses addresses with "bounce" ──
const inbox: { to: string[] }[] = [];
const smtp = net.createServer((sock) => {
  let rcpt: string[] = [];
  let data = false;
  let authStep = 0;
  sock.write("220 e2e ESMTP\r\n");
  sock.on("data", (buf) => {
    for (const line of buf.toString().split("\r\n")) {
      if (data) {
        if (line === ".") { data = false; inbox.push({ to: rcpt }); rcpt = []; sock.write("250 OK queued as e2e" + inbox.length + "\r\n"); }
        continue;
      }
      if (!line) continue;
      if (authStep === 1) { authStep = 2; sock.write("334 UGFzc3dvcmQ6\r\n"); continue; }
      if (authStep === 2) { authStep = 0; sock.write("235 OK\r\n"); continue; }
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === "EHLO" || cmd === "HELO") sock.write("250-e2e\r\n250 AUTH PLAIN LOGIN\r\n");
      else if (line.toUpperCase().startsWith("AUTH PLAIN")) sock.write("235 OK\r\n");
      else if (line.toUpperCase().startsWith("AUTH LOGIN")) { authStep = 1; sock.write("334 VXNlcm5hbWU6\r\n"); }
      else if (cmd === "MAIL") sock.write("250 OK\r\n");
      else if (cmd === "RCPT") {
        const addr = (line.match(/<([^>]*)>/) ?? [])[1] ?? "";
        if (/bounce/.test(addr)) sock.write("550 No such user\r\n"); else { rcpt.push(addr); sock.write("250 OK\r\n"); }
      } else if (cmd === "DATA") { data = true; sock.write("354 Go ahead\r\n"); }
      else if (cmd === "QUIT") { sock.write("221 Bye\r\n"); sock.end(); }
      else sock.write("250 OK\r\n");
    }
  });
}).listen(Number(process.env.SMTP_PORT), "127.0.0.1");

async function main() {
  await mongoose.connect(uri);
  step("Setting up");
  const org = await Organization.create({
    name: "Email Log E2E", baseCurrency: "AED",
    taxRates: [{ label: "VAT 5%", code: "VAT", rate: 5, isDefault: true, appliesTo: "sales" }],
  });
  const orgId = String(org._id);
  for (const def of SYSTEM_ROLES) {
    await Role.create({ organizationId: org._id, key: def.key, name: def.name, description: def.description, permissions: def.permissions, isSystem: true });
  }
  const roles = await Role.find({ organizationId: org._id }).lean();
  const roleId = (key: string) => new Types.ObjectId(String(roles.find((r) => r.key === key)!._id));
  const passwordHash = await hashPassword(PASSWORD);
  const member = (name: string, email: string, role: string) =>
    User.create({ name, email, passwordHash, status: "active", memberships: [{ organizationId: org._id, roleId: roleId(role), status: "active" }] });
  await member("Approver", "approver@e2e-test.com", "admin");
  await member("Sally Sales", "sally@e2e-test.com", "salesperson");
  await member("Asha Accounts", "accounts@e2e-test.com", "accountant");
  await member("Manny Manager", "manager@e2e-test.com", "manager");
  const tAdmin = await login("approver@e2e-test.com");
  const tSales = await login("sally@e2e-test.com");
  const tAccounts = await login("accounts@e2e-test.com");
  const tManager = await login("manager@e2e-test.com");

  let n = 0;
  const enrol = (over: Record<string, unknown> = {}) => {
    n++;
    return signedPost(orgId, "/api/v1/integrations/enrolments", {
      externalId: `mail-${n}`, source: "crm", crm: "delta",
      customer: { name: `Client ${n}`, email: `client${n}@e2e-test.com`, phone: `+97150000${String(n).padStart(4, "0")}` },
      course: { name: "Course 1", amountMinor: 49_900 },
      declaredPaidMinor: 10_000,
      modeOfStudy: "online", language: "English", salespersonEmail: "sally@e2e-test.com", salespersonName: "Sally Sales",
      ...over,
    });
  };
  const idOf = (r: Res) => String(r.body?.data?.invoiceId ?? r.body?.invoiceId);
  const emailsOf = async (id: string, token = tAdmin) => (await request("GET", `/invoices/${id}/emails`, undefined, token));
  const settle = () => new Promise((r) => setTimeout(r, 1500));

  step("Case 1 — approving an enrolment emails the client and the salesperson");
  const e1 = await enrol();
  check("an enrolment arrives", e1.status === 200 || e1.status === 201, show(e1));
  const id1 = idOf(e1);
  check("nothing is emailed before it is approved", ((await emailsOf(id1)).body?.data ?? []).length === 0);
  const ap = await request("POST", `/invoices/${id1}/approval/approve`, undefined, tAdmin);
  check("approved", ap.status === 200, show(ap));
  await settle();
  let list = (await emailsOf(id1)).body?.data ?? [];
  const client = list.find((r: any) => r.kind === "invoice_approved");
  const copy = list.find((r: any) => r.kind === "invoice_salesperson");
  check("the client got the invoice — Sent, by the approver", client?.state === "sent" && client.to[0] === "client1@e2e-test.com" && client.actorName === "Approver", JSON.stringify(list));
  check("the salesperson got a copy — Sent", copy?.state === "sent" && copy.to[0] === "sally@e2e-test.com", JSON.stringify(copy));
  check("both really reached the mail server", inbox.some((m) => m.to.includes("client1@e2e-test.com")) && inbox.some((m) => m.to.includes("sally@e2e-test.com")));
  check("the invoice says it was delivered", (await Invoice.findById(id1).lean() as any)?.emailDelivery?.state === "sent");

  step("Case 2 — Resend, a refused address, no address, and a draft");
  const rs = await request("POST", `/invoices/${id1}/resend`, { message: "Again" }, tAdmin);
  check("Resend is accepted", rs.status < 300, show(rs));
  await settle();
  list = (await emailsOf(id1)).body?.data ?? [];
  check("Resend is logged, newest first, with who pressed it", list[0]?.kind === "invoice_resend" && list[0]?.actorName === "Approver" && list[0]?.state === "sent", JSON.stringify(list[0]));
  const e2 = await enrol({ customer: { name: "Bounce Client", email: "bounce@e2e-test.com", phone: "+971500009998" } });
  await request("POST", `/invoices/${idOf(e2)}/approval/approve`, undefined, tAdmin);
  await settle();
  const l2 = (await emailsOf(idOf(e2))).body?.data ?? [];
  check("a refused address is Failed, with the reason", l2.find((r: any) => r.kind === "invoice_approved")?.state === "failed" && !!l2.find((r: any) => r.kind === "invoice_approved")?.error, JSON.stringify(l2));
  check("…and the salesperson's copy still went", l2.find((r: any) => r.kind === "invoice_salesperson")?.state === "sent");
  const e3 = await enrol({ customer: { name: "No Mail Client", email: "", phone: "+971500009997" } });
  if (e3.status < 300) {
    await request("POST", `/invoices/${idOf(e3)}/approval/approve`, undefined, tAdmin);
    await settle();
    const l3 = (await emailsOf(idOf(e3))).body?.data ?? [];
    check("a client with no email: No email address, and the salesperson still gets the copy",
      l3.find((r: any) => r.kind === "invoice_approved")?.state === "no_address" && l3.find((r: any) => r.kind === "invoice_salesperson")?.state === "sent", JSON.stringify(l3));
  } else {
    check("an enrolment without an email is refused by the intake, so cannot be approved unmailed", true);
  }
  // A draft typed in finance, waiting for approval: approving it does not issue it.
  const draft = await Invoice.findById(id1).lean() as any;
  const d = await Invoice.create({
    ...Object.fromEntries(Object.entries(draft).filter(([k]) => !["_id", "invoiceNumber", "createdAt", "updatedAt", "enrolment", "external", "emailDelivery", "sentAt", "payments", "approval"].includes(k))),
    invoiceNumber: "IN-DRAFT-1", status: "draft", amountPaidMinor: 0,
    approval: { state: "pending", submittedAt: new Date() },
  });
  const apd = await request("POST", `/invoices/${d._id}/approval/approve`, undefined, tAdmin);
  await settle();
  const dl = (await emailsOf(String(d._id))).body?.data ?? [];
  check("a draft typed here is not emailed to the client by its approval — it still waits for Send",
    apd.status === 200 && !dl.some((r: any) => r.kind.startsWith("invoice")) && (await Invoice.findById(d._id).lean() as any)?.status === "draft", JSON.stringify(dl));

  step("Case 3 — the log page");
  const page = await request("GET", "/email-logs?pageSize=100", undefined, tAccounts);
  check("an accountant reads the whole log", page.status === 200 && page.body?.data?.length >= 5 && page.body?.meta?.total >= 5, show(page));
  const failedOnly = await request("GET", "/email-logs?state=failed", undefined, tAdmin);
  check("filtered to Failed", failedOnly.status === 200 && failedOnly.body?.data?.every((r: any) => r.state === "failed") && failedOnly.body?.data?.length >= 1);
  const search = await request("GET", "/email-logs?search=bounce", undefined, tAdmin);
  check("searched by address", search.body?.data?.length >= 1 && search.body.data.every((r: any) => r.to.join().includes("bounce") || /bounce/i.test(r.subject)), show(search));
  const bad = await request("GET", "/email-logs?state=maybe", undefined, tAdmin);
  check("a result that is not one: refused", bad.status === 422 || bad.status === 400, show(bad));

  step("Case 4 — who may see it");
  check("a salesperson may not read the log", (await request("GET", "/email-logs", undefined, tSales)).status === 403);
  check("nor a manager", (await request("GET", "/email-logs", undefined, tManager)).status === 403);
  check("not signed in: 401", (await request("GET", "/email-logs")).status === 401);
  const own = await emailsOf(id1, tSales);
  check("the salesperson sees their own invoice's emails", own.status === 200 && (own.body?.data ?? []).length >= 3, show(own));

  console.log(`\n${checks - failures}/${checks} checks passed`);
  smtp.close();
  await mongoose.disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
