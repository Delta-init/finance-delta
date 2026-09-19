/**
 * Drives the three mail fixes over real HTTP against a real API process, with
 * a real SMTP server standing in for the mail provider.
 *
 * What is being checked is not "does an email get composed" — it is the three
 * ways this system used to lie about mail:
 *
 *   1. An invoice said "Sent" whether or not the message left, because the
 *      dispatch is unawaited and every failure was silent.
 *   2. A reminder fired on whatever was true when the invoice was issued, so
 *      an invoice paid the next day was still chased for payment.
 *   3. A placeholder FROM_EMAIL failed per-email, invisibly, rather than once
 *      at boot where somebody would see it.
 *
 * The SMTP server here is a real one, small enough to read: mail is actually
 * spoken over a socket and captured, so the transport is exercised rather than
 * mocked. Scratch database only.
 */
import mongoose, { Types } from "mongoose";
import { createServer, type Socket } from "net";
import { SYSTEM_ROLES } from "@delta/shared";
import { hashPassword } from "../lib/password";
import { Organization } from "../modules/organization/organization.model";
import { Role } from "../modules/role/role.model";
import { User } from "../modules/user/user.model";
import { Customer } from "../modules/customer/customer.model";

const uri = process.env.MONGODB_URI ?? "";
if (!/127\.0\.0\.1|localhost/.test(uri) || !/e2e|test/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch database, got "${uri}"`);
  process.exit(1);
}

const PORT = process.env.E2E_API_PORT ?? "4115";
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = "E2ePassword1!";

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
function step(name: string) { console.log(`\n\x1b[1m${name}\x1b[0m`); }

// ── A mail server, small enough to read ──────────────────────────────────────
interface Caught { to: string[]; subject: string; body: string }
const caught: Caught[] = [];

function startSmtp(port: number): Promise<() => void> {
  const server = createServer((sock: Socket) => {
    let inData = false;
    let data = "";
    const rcpt: string[] = [];
    sock.write("220 scratch ESMTP\r\n");
    sock.on("data", (buf) => {
      for (const raw of buf.toString().split(/\r?\n/)) {
        if (inData) {
          if (raw === ".") {
            inData = false;
            const subject = /^Subject: (.*)$/mi.exec(data)?.[1] ?? "";
            caught.push({ to: [...rcpt], subject, body: data });
            rcpt.length = 0; data = "";
            sock.write("250 OK\r\n");
          } else data += raw + "\n";
          continue;
        }
        const line = raw.trim();
        if (!line) continue;
        const cmd = line.split(" ")[0]!.toUpperCase();
        if (cmd === "EHLO" || cmd === "HELO") sock.write("250-scratch\r\n250 AUTH PLAIN LOGIN\r\n");
        else if (cmd === "AUTH") sock.write("235 authenticated\r\n");
        else if (cmd === "MAIL") sock.write("250 OK\r\n");
        else if (cmd === "RCPT") { rcpt.push(/<(.+?)>/.exec(line)?.[1] ?? line); sock.write("250 OK\r\n"); }
        else if (cmd === "DATA") { inData = true; sock.write("354 go ahead\r\n"); }
        else if (cmd === "QUIT") { sock.write("221 bye\r\n"); sock.end(); }
        else sock.write("250 OK\r\n");
      }
    });
    sock.on("error", () => {});
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve(() => server.close()));
  });
}

type Res = { status: number; body: Record<string, never> };
async function request(method: string, p: string, body?: unknown, token?: string): Promise<Res> {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, never> };
}
const post = (p: string, b?: unknown, t?: string) => request("POST", p, b, t);
const get = (p: string, t?: string) => request("GET", p, undefined, t);

/** The dispatch is deliberately unawaited, so give it a moment to land. */
const settle = () => new Promise((r) => setTimeout(r, 600));

async function main() {
  const stopSmtp = await startSmtp(Number(process.env.E2E_SMTP_PORT ?? 2526));
  await mongoose.connect(uri);
  await mongoose.connection.dropDatabase();

  step("Setting up an organization");
  const org = await Organization.create({ name: "Delta HQ", baseCurrency: "AED" });
  for (const def of SYSTEM_ROLES) {
    await Role.create({
      organizationId: org._id, key: def.key, name: def.name,
      description: def.description, permissions: def.permissions, isSystem: true,
    });
  }
  const roles = await Role.find({ organizationId: org._id }).lean();
  const adminRoleId = String(roles.find((r) => r.key === "admin")!._id);
  const admin = await User.create({
    name: "Org Admin", email: "admin@e2e-test.com",
    passwordHash: await hashPassword(PASSWORD), status: "active",
    memberships: [{ organizationId: org._id, roleId: new Types.ObjectId(adminRoleId), status: "active" }],
  });

  const withEmail = await Customer.create({
    organizationId: org._id, customerCode: "CUS-00001", name: "Reachable Client",
    email: "client@e2e-test.com", phone: "+971500000000", currency: "AED", status: "active",
  });
  // The model requires an email today, but records predating that do not have
  // one and are exactly the case the guard is for — so the address is cleared
  // after the fact rather than never set.
  const noEmail = await Customer.create({
    organizationId: org._id, customerCode: "CUS-00002", name: "Unreachable Client",
    email: "temporary@e2e-test.com", phone: "+971500000001", currency: "AED", status: "active",
  });
  await Customer.collection.updateOne({ _id: noEmail._id }, { $unset: { email: "" } });

  const login = await post("/auth/login", { email: "admin@e2e-test.com", password: PASSWORD });
  const token = (login.body?.data as unknown as { accessToken?: string } | undefined)?.accessToken;
  if (!token) throw new Error(`login failed: ${JSON.stringify(login.body).slice(0, 200)}`);

  const today = new Date().toISOString().slice(0, 10);
  // Comfortably ahead, so "sent" is not immediately reported as "overdue" —
  // the status derives overdue from the due date, and today's date is already
  // in the past by the time it is compared.
  const nextMonth = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

  async function makeInvoice(customerId: string, totalMinor: number): Promise<string> {
    const r = await post("/invoices", {
      customerId, salespersonId: String(admin._id), issueDate: today, dueDate: nextMonth,
      currency: "AED",
      lineItems: [{ description: "Consulting", quantity: 1, unitPriceMinor: totalMinor }],
    }, token);
    const inv = r.body?.data as unknown as { id?: string } | undefined;
    if (!inv?.id) throw new Error(`invoice failed: ${JSON.stringify(r.body).slice(0, 300)}`);
    return inv.id;
  }
  const read = async (id: string) =>
    (await get(`/invoices/${id}`, token)).body?.data as unknown as {
      status?: string; balanceMinor?: number;
      emailDelivery?: { state?: string; error?: string; messageId?: string };
    };

  // ── ② The invoice stops claiming it was sent ──────────────────────────────
  step("Saying whether the invoice actually went");
  {
    const id = await makeInvoice(String(withEmail._id), 100_000);
    const before = caught.length;
    const sent = await post(`/invoices/${id}/send`, undefined, token);
    check("an invoice can be sent", sent.status === 200, `${sent.status} ${JSON.stringify(sent.body).slice(0, 160)}`);
    await settle();

    const d = await read(id);
    check("...the status moves to sent", d?.status === "sent", `got ${d?.status}`);
    check("...a message really left over SMTP", caught.length === before + 1, `${caught.length - before} caught`);
    check("...addressed to the customer", caught.at(-1)?.to.includes("client@e2e-test.com") === true, JSON.stringify(caught.at(-1)?.to));
    check("...and the invoice records that it was delivered", d?.emailDelivery?.state === "sent", `got ${JSON.stringify(d?.emailDelivery)}`);
    check("...keeping the transport's own id", Boolean(d?.emailDelivery?.messageId), "no messageId");

    // The document, not just a paragraph describing it. Checked in the raw
    // message that crossed the socket: a MIME part naming the invoice, and a
    // PDF really inside it rather than an empty part with the right name.
    const raw = caught.at(-1)?.body ?? "";
    check("...carrying the invoice as a PDF", /application\/pdf/i.test(raw), "no pdf part");
    check("...named after the invoice", /filename=.?IN-\d+\.pdf/i.test(raw), "attachment not named for the invoice");
    const b64 = /Content-Type: application\/pdf[\s\S]*?\r?\n\r?\n([A-Za-z0-9+/=\s]+)/i.exec(raw)?.[1] ?? "";
    const bytes = Buffer.from(b64.replace(/\s/g, ""), "base64");
    check("...and the part really is a PDF", bytes.subarray(0, 5).toString() === "%PDF-", `starts "${bytes.subarray(0, 8).toString()}"`);
    check("...of a believable size", bytes.byteLength > 2000, `${bytes.byteLength} bytes`);

    // The message is readable on its own, without opening the attachment.
    const html = Buffer.from(
      (/Content-Type: text\/html[\s\S]*?\r?\n\r?\n([A-Za-z0-9+/=\s]+)/i.exec(raw)?.[1] ?? "").replace(/\s/g, ""),
      "base64",
    ).toString() || raw;
    check("the message writes the invoice out too", /Consulting/.test(html), "no line items in the body");
    check("...with the amount against the line", /1,000\.00/.test(html), "no line amount");
    check("...its subtotal and total", /Subtotal/i.test(html) && /Balance Due/i.test(html), "no totals block");
    check("...and says the PDF is attached", /PDF copy of this invoice is attached/i.test(html), "no attachment note");
  }
  {
    // A client name that is ordinary and also HTML. It must not be able to
    // close a tag in the mail it is sent.
    const nasty = await Customer.create({
      organizationId: org._id, customerCode: "CUS-00003",
      name: 'Smith & Sons <Trading>', email: "nasty@e2e-test.com",
      phone: "+971500000002", currency: "AED", status: "active",
    });
    const id = await makeInvoice(String(nasty._id), 30_000);
    await post(`/invoices/${id}/send`, undefined, token);
    await settle();
    const raw = caught.at(-1)?.body ?? "";
    const html = Buffer.from(
      (/Content-Type: text\/html[\s\S]*?\r?\n\r?\n([A-Za-z0-9+/=\s]+)/i.exec(raw)?.[1] ?? "").replace(/\s/g, ""),
      "base64",
    ).toString() || raw;
    check("a name containing markup is escaped", !/<Trading>/.test(html), "raw tag reached the message");
    check("...while still reading correctly", /Smith &amp; Sons/.test(html) || /Smith & Sons/.test(html), "name lost");
  }
  {
    // The commonest silent failure: nowhere to send it.
    const id = await makeInvoice(String(noEmail._id), 50_000);
    const before = caught.length;
    await post(`/invoices/${id}/send`, undefined, token);
    await settle();

    const d = await read(id);
    check("a customer with no address sends nothing", caught.length === before, `${caught.length - before} caught`);
    check("...and the invoice says so", d?.emailDelivery?.state === "no_address", `got ${JSON.stringify(d?.emailDelivery)}`);
    check("...naming the customer", /Unreachable Client/.test(d?.emailDelivery?.error ?? ""), `got "${d?.emailDelivery?.error}"`);
    // The status still moves — sending is a decision, delivery is an outcome,
    // and conflating them is what the old behaviour did.
    check("...while the status still records the decision", d?.status === "sent", `got ${d?.status}`);
  }

  // ── ③ A settled invoice is not chased ─────────────────────────────────────
  step("Not chasing somebody who has already paid");
  {
    const { stillOwed } = await import("../jobs/reminder.worker");
    const orgId = String(org._id);

    const owing = await makeInvoice(String(withEmail._id), 100_000);
    await post(`/invoices/${owing}/send`, undefined, token);
    check("an unpaid invoice is still owed", (await stillOwed(owing, orgId)).ok === true);

    const paid = await makeInvoice(String(withEmail._id), 100_000);
    await post(`/invoices/${paid}/send`, undefined, token);
    await post(`/invoices/${paid}/payments`, { method: "cash", amountMinor: 100_000, paidOn: today }, token);
    const settled = await stillOwed(paid, orgId);
    check("a settled invoice is not", settled.ok === false, `got ${JSON.stringify(settled)}`);
    check("...saying why", settled.why === "invoice is settled", `got "${settled.why}"`);

    const part = await makeInvoice(String(withEmail._id), 100_000);
    await post(`/invoices/${part}/send`, undefined, token);
    await post(`/invoices/${part}/payments`, { method: "cash", amountMinor: 40_000, paidOn: today }, token);
    check("a part-paid invoice is still chased", (await stillOwed(part, orgId)).ok === true);

    const voided = await makeInvoice(String(withEmail._id), 100_000);
    await post(`/invoices/${voided}/send`, undefined, token);
    await post(`/invoices/${voided}/void`, undefined, token);
    const v = await stillOwed(voided, orgId);
    check("a voided invoice is not chased", v.ok === false, `got ${JSON.stringify(v)}`);
    check("...saying why", v.why === "invoice was voided", `got "${v.why}"`);

    const gone = await stillOwed(String(new Types.ObjectId()), orgId);
    check("an invoice that no longer exists is not chased", gone.ok === false, `got ${JSON.stringify(gone)}`);

    // Another organization's invoice is not this organization's to chase.
    const foreign = await stillOwed(owing, String(new Types.ObjectId()));
    check("...nor one belonging to another organization", foreign.ok === false, `got ${JSON.stringify(foreign)}`);
  }

  // ── Notices go out too, not only invoices ─────────────────────────────────
  step("The other messages use the same transport");
  {
    const before = caught.length;
    await post("/auth/forgot-password", { email: "admin@e2e-test.com" });
    await settle();
    check("a password reset reaches the mail server", caught.length > before, `${caught.length - before} caught`);
    check("...with a subject that says what it is", /password/i.test(caught.at(-1)?.subject ?? ""), `"${caught.at(-1)?.subject}"`);
  }

  stopSmtp();
  await mongoose.disconnect();
  console.log("");
  if (failures) { console.log(`\x1b[31m${failures} of ${checks} checks failed\x1b[0m`); process.exit(1); }
  console.log(`\x1b[32mAll ${checks} checks passed\x1b[0m`);
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
