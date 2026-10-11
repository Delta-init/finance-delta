/**
 * Partial enrolments' next instalment (the user, 2026-10-11), over real HTTP
 * against a real API process, with Tetra Commission and the mail server as
 * stand-ins in this driver:
 *
 *   A. The due date at approval: the latest payment's paidOn + 29 days; paid in
 *      full or nothing paid, left as it was; no longer "overdue" next day.
 *   B. Every payment recorded, edited or deleted restarts it from the latest.
 *   C. Fee updates to Tetra Commission: only for students sent there; the whole
 *      picture; retried while it is down; 404 UNKNOWN_INVOICE stops it; a change
 *      made mid-send is sent after; void, restore, delete, credit note, and the
 *      moment the student is sent there.
 *   D. Client reminders 3, 2 and 1 day before (time-travelled by "now", by the
 *      UAE day) — once each, Forex only, never paid / void / not due.
 *   E. A balance payment a CS records in Tetra Commission (ENROLMENT_PAYMENT):
 *      checked on arrival, approved here → recorded on the invoice, decision
 *      back, fee update; more than the balance refused; the invoice's own
 *      organization; finished by the worker if the approval died part-way.
 *   F. The one-off backfill: prints, changes only with --write, idempotent.
 *
 * Run through scripts/instalments-e2e.sh. Scratch database only.
 */
import crypto from "node:crypto";
import { createServer, type Socket } from "node:net";
import mongoose, { Types } from "mongoose";
import { SYSTEM_ROLES } from "@delta/shared";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri) || /:27017\//.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1 (not 27017), got "${uri}"`);
  process.exit(1);
}
const { env } = await import("../config/env");
if (!/^http:\/\/127\.0\.0\.1:/.test(env.COMMISSION_API_URL) || env.SMTP_HOST !== "127.0.0.1" || env.RESEND_API_KEY) {
  console.error("Refusing to run: Tetra Commission and mail must be the local stand-ins");
  process.exit(1);
}

const { hashPassword } = await import("../lib/password");
const { Organization } = await import("../modules/organization/organization.model");
const { Role } = await import("../modules/role/role.model");
const { User } = await import("../modules/user/user.model");
const { Invoice } = await import("../modules/invoice/invoice.model");
const { EmailLog } = await import("../modules/email-log/email-log.model");
const { LmsProvision } = await import("../modules/integrations/lms-provision.model");
const { CommissionFeeUpdateModel } = await import("../modules/integrations/commission-fee-update.model");
const { drainFeeUpdates } = await import("../modules/integrations/commission-fee-update.service");
const { TetraDepositModel } = await import("../modules/tetra-deposit/tetra-deposit.model");
const { drainTetraDepositDecisions } = await import("../modules/tetra-deposit/tetra-deposit.service");
const { runInstalmentReminders } = await import("../jobs/instalment-reminder.worker");
const { InstalmentReminder } = await import("../modules/invoice/instalment-reminder.model");
const { drainCommissionStudents } = await import("../jobs/lms-provision.worker");
const { backfillInstalmentDue } = await import("./instalment-due-backfill");

const ORIGIN = `http://127.0.0.1:${process.env.E2E_API_PORT}`;
const BASE = `${ORIGIN}/api/v1`;
const INBOUND_ID = process.env.INBOUND_CLIENT_ID ?? "";
const INBOUND_SECRET = process.env.INBOUND_INTEGRATION_SECRET ?? "";
const PASSWORD = "E2ePassword1!";

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
function step(s: string) { console.log(`\n\x1b[1m${s}\x1b[0m`); }

/* ── Days ── */
const DAY = 86_400_000;
const today = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
const dayOf = (offset: number) => new Date(today.getTime() + offset * DAY).toISOString().slice(0, 10);
const plus = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00.000Z`) + n * DAY).toISOString().slice(0, 10);
const iso = (d: unknown) => (d ? new Date(d as string).toISOString().slice(0, 10) : "");
/** 10:00 in the UAE on that date. */
const uaeTen = (d: string) => new Date(`${d}T06:00:00.000Z`);

/* ── A stand-in mail server ── */
interface Caught { to: string[]; subject: string; body: string }
const caught: Caught[] = [];
function startSmtp(port: number): Promise<void> {
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
        else if (cmd === "RCPT") { rcpt.push(/<(.+?)>/.exec(line)?.[1] ?? line); sock.write("250 OK\r\n"); }
        else if (cmd === "DATA") { inData = true; sock.write("354 go ahead\r\n"); }
        else if (cmd === "QUIT") { sock.write("221 bye\r\n"); sock.end(); }
        else sock.write("250 OK\r\n");
      }
    });
    sock.on("error", () => {});
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
}
/** A quoted-printable body, read as text. */
const plain = (body: string) => body.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

/* ── A stand-in Tetra Commission ── */
type Mode = "ok" | "down" | "unknown" | "noroute" | "slow" | "older";
const feeMode = new Map<string, Mode>();
const feeUpdates: any[] = [];
const decisions: any[] = [];
let releaseSlow: (() => void) | null = null;
let slowArrived = false;
Bun.serve({
  port: Number(process.env.E2E_FAKE_TC_PORT),
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (req.headers.get("x-finance-secret") !== env.COMMISSION_S2S_SECRET) return Response.json({ error: { code: "UNAUTHORIZED", message: "Bad secret" } }, { status: 401 });
    const body = (await req.json().catch(() => ({}))) as any;
    if (path === "/api/v1/integrations/finance/fee-updates") {
      const mode = feeMode.get(body.invoiceId) ?? "ok";
      if (mode === "down") return Response.json({ error: { message: "Tetra Commission is down" } }, { status: 503 });
      if (mode === "noroute") return Response.json({ error: "Not found" }, { status: 404 });
      if (mode === "older") { feeUpdates.push(body); return Response.json({ applied: false, ignored: "older" }); }
      if (mode === "unknown") return Response.json({ error: { code: "UNKNOWN_INVOICE", message: "No course fee for this invoice" } }, { status: 404 });
      if (mode === "slow") {
        slowArrived = true;
        await new Promise<void>((r) => { releaseSlow = r; });
      }
      feeUpdates.push(body);
      return Response.json({ data: { applied: true } });
    }
    if (path === "/api/v1/integrations/finance/funding-decisions") {
      decisions.push(body);
      return Response.json({ data: { fundingId: body.fundingId, status: body.decision === "approved" ? "APPROVED" : "REJECTED", amountUsd: 0, transactionId: body.transactionId ?? "", already: false, credited: 0, levelUpgraded: false } });
    }
    if (path === "/api/v1/integrations/finance/students") {
      return Response.json({ data: { created: true, existing: null, studentId: new Types.ObjectId().toString(), studentCode: "STU-0100", assignment: "assigned", mentorName: "Chief", teamName: "Chief", detail: "" } });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  },
});
const lastFeeFor = (invoiceId: string) => [...feeUpdates].reverse().find((f) => f.invoiceId === invoiceId);

/* ── HTTP ── */
type Res = { status: number; body: Record<string, any> };
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`;
async function request(method: string, p: string, body?: unknown, token?: string): Promise<Res> {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
}
async function signedPost(orgId: string, p: string, payload: unknown): Promise<Res> {
  const raw = JSON.stringify(payload);
  const ts = String(Date.now());
  const nonce = crypto.randomUUID();
  const canonical = ["POST", p, ts, nonce, crypto.createHash("sha256").update(raw).digest("hex")].join("\n");
  const r = await fetch(`${ORIGIN}${p}`, {
    method: "POST",
    headers: {
      "content-type": "application/json", "x-delta-client": INBOUND_ID, "x-delta-timestamp": ts, "x-delta-nonce": nonce,
      "x-delta-signature": crypto.createHmac("sha256", INBOUND_SECRET).update(canonical).digest("hex"), "x-delta-org": orgId,
    },
    body: raw,
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
}
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));
/** The API queues a fee update just after it answers: give it a moment, then run the worker's pass. */
const drain = async (now?: Date) => { await settle(); return drainFeeUpdates(now); };

async function main() {
  await startSmtp(Number(process.env.E2E_SMTP_PORT));
  await mongoose.connect(uri);
  if (mongoose.connection.host !== "127.0.0.1") throw new Error("not 127.0.0.1");
  await mongoose.connection.dropDatabase();

  step("Setting up");
  const mkOrg = async (name: string, currency: string) => {
    const org = await Organization.create({ name, baseCurrency: currency, email: "accounts@e2e-test.com", phone: "+971 4 000 0000", taxRates: [{ label: "VAT 5%", code: "VAT", rate: 5, isDefault: true, appliesTo: "sales" }] });
    for (const def of SYSTEM_ROLES) {
      await Role.create({ organizationId: org._id, key: def.key, name: def.name, description: def.description, permissions: def.permissions, isSystem: true });
    }
    const roles = await Role.find({ organizationId: org._id }).lean();
    return { org, roleId: (key: string) => new Types.ObjectId(String(roles.find((r) => r.key === key)!._id)) };
  };
  const hq = await mkOrg("Delta HQ E2E", "AED");
  const blr = await mkOrg("Bangalore E2E", "INR");
  const passwordHash = await hashPassword(PASSWORD);
  await User.create({ name: "Accounts Admin", email: "accounts.admin@e2e-test.com", passwordHash, status: "active", memberships: [{ organizationId: hq.org._id, roleId: hq.roleId("admin"), status: "active" }] });
  await User.create({ name: "Sally Sales", email: "sally@e2e-test.com", passwordHash, status: "active", memberships: [
    { organizationId: hq.org._id, roleId: hq.roleId("salesperson"), status: "active" },
    { organizationId: blr.org._id, roleId: blr.roleId("salesperson"), status: "active" },
  ] });
  const login = await request("POST", "/auth/login", { email: "accounts.admin@e2e-test.com", password: PASSWORD });
  const token = login.body?.data?.accessToken as string;
  check("an accountant (admin) can sign in", Boolean(token), show(login));
  const HQ = String(hq.org._id);

  let n = 0;
  /** A CRM close, approved: `paid` declared as one payment on `paidOn`. */
  async function close(opts: { fee?: number; paid?: number; paidOn?: string; org?: string; approve?: boolean; course?: string } = {}) {
    n++;
    const fee = opts.fee ?? 100_000;
    const paid = opts.paid ?? 40_000;
    const r = await signedPost(opts.org ?? HQ, "/api/v1/integrations/enrolments", {
      externalId: `inst-${n}`, source: "crm", crm: "remote",
      customer: { name: `Client ${n}`, email: `client${n}@e2e-test.com`, phone: `+97150000${String(n).padStart(4, "0")}` },
      course: { name: opts.course ?? "Delta Wave Theory", amountMinor: fee },
      modeOfStudy: "online", language: "English", salespersonEmail: "sally@e2e-test.com", salespersonName: "Sally Sales",
      enrolledOn: dayOf(-3),
      declaredPaidMinor: paid,
      ...(paid > 0 ? { declaredPaymentMethod: "cash", payments: [{ method: "cash", amountMinor: paid, paidOn: opts.paidOn ?? dayOf(-2) }] } : {}),
    });
    const id = String(r.body?.data?.invoiceId ?? "");
    if (!id) throw new Error(`enrolment refused: ${show(r)}`);
    if (opts.approve !== false && (opts.org ?? HQ) === HQ) {
      const a = await request("POST", `/invoices/${id}/approval/approve`, undefined, token);
      if (a.status !== 200) throw new Error(`approval refused: ${show(a)}`);
    }
    return id;
  }
  const inv = async (id: string) => (await Invoice.findById(id).lean()) as any;
  /** As the LMS provisioning leaves it: a Forex student sent on to Tetra Commission (or not). */
  async function provision(id: string, opts: { program?: string; commission?: string } = {}) {
    const i = await inv(id);
    await LmsProvision.create({
      organizationId: i.organizationId, invoiceId: i._id, invoiceNumber: i.invoiceNumber, source: "crm", status: "sent",
      payload: { email: `client-${i.invoiceNumber}@e2e-test.com`.toLowerCase(), crm: "remote" },
      lmsCourseSlug: "dwt", lmsCourseTitle: "Delta Wave Theory Trading Programme", lmsCourseProgram: opts.program ?? "4x-trading",
      ...(opts.commission !== "none" ? { commission: { state: opts.commission ?? "sent", studentCode: "STU-0001" } } : {}),
    });
  }

  /* ── A ── */
  step("A. The due date at approval");
  const a1 = await close({ paid: 40_000, paidOn: dayOf(-2) });
  let d = await inv(a1);
  check("part paid at the close: due 29 days after the money was paid", iso(d.dueDate) === plus(dayOf(-2), 29) && d.status === "partial", `${iso(d.dueDate)} ${d.status}`);
  let got = await request("GET", `/invoices/${a1}`, undefined, token);
  check("…so it reads partial, not overdue, after the close", got.body?.data?.status === "partial" && got.body?.data?.dueDate === plus(dayOf(-2), 29), show(got));
  const a2 = await close({ fee: 50_000, paid: 50_000 });
  d = await inv(a2);
  check("paid in full at the close: the due date is left as it was", d.status === "paid" && iso(d.dueDate) === dayOf(-3), `${iso(d.dueDate)} ${d.status}`);
  const a3 = await close({ paid: 0 });
  d = await inv(a3);
  check("nothing paid: left as it was", iso(d.dueDate) === dayOf(-3) && (d.payments ?? []).length === 0, iso(d.dueDate));

  /* ── B ── */
  step("B. Every payment restarts the 29 days from the latest");
  let r = await request("POST", `/invoices/${a1}/payments`, { method: "bank_transfer", amountMinor: 10_000, paidOn: dayOf(0) }, token);
  d = await inv(a1);
  check("a payment today: due today + 29", r.status < 300 && iso(d.dueDate) === dayOf(29), `${show(r)} ${iso(d.dueDate)}`);
  r = await request("POST", `/invoices/${a1}/payments`, { method: "cash", amountMinor: 5_000, paidOn: dayOf(-5) }, token);
  d = await inv(a1);
  check("one recorded late, paid earlier: still from the latest paidOn", iso(d.dueDate) === dayOf(29), iso(d.dueDate));
  const todays = (d.payments as any[]).find((p) => iso(p.paidOn) === dayOf(0));
  r = await request("PATCH", `/invoices/${a1}/payments/${todays._id}`, { method: "bank_transfer", amountMinor: 10_000, paidOn: dayOf(-1) }, token);
  d = await inv(a1);
  check("its date edited to yesterday: due yesterday + 29", r.status < 300 && iso(d.dueDate) === dayOf(28), `${show(r)} ${iso(d.dueDate)}`);
  r = await request("DELETE", `/invoices/${a1}/payments/${todays._id}`, undefined, token);
  d = await inv(a1);
  check("deleted: back to the latest one left (the close's)", r.status < 300 && iso(d.dueDate) === plus(dayOf(-2), 29), `${show(r)} ${iso(d.dueDate)}`);
  check("no fee update for a student who never went to Tetra Commission", (await CommissionFeeUpdateModel.countDocuments({ invoiceId: a1 })) === 0);

  /* ── C ── */
  step("C. Fee updates to Tetra Commission");
  await provision(a1);
  r = await request("POST", `/invoices/${a1}/payments`, { method: "card", amountMinor: 5_000, paidOn: dayOf(0) }, token);
  await settle();
  let row = await CommissionFeeUpdateModel.findOne({ invoiceId: a1 }).lean() as any;
  check("a payment on a student who went there: queued", row?.state === "pending" && row?.reason === "payment", JSON.stringify(row));
  await drain();
  let fee = lastFeeFor(a1);
  d = await inv(a1);
  check("delivered, with the whole picture", fee && fee.invoiceNumber === d.invoiceNumber && fee.currency === "AED" && fee.totalMinor === 100_000
    && fee.paidMinor === 50_000 && fee.balanceMinor === 50_000 && fee.status === "partial" && fee.nextDueOn === dayOf(29)
    && fee.course === "Delta Wave Theory Trading Programme" && fee.email === `client-${d.invoiceNumber}@e2e-test.com`.toLowerCase(), JSON.stringify(fee));
  check("…each payment with its date and method, oldest first", fee?.payments?.length === 3 && fee.payments[0].paidOn === dayOf(-5)
    && fee.payments.at(-1).paidOn === dayOf(0) && fee.payments.at(-1).method === "Card" && typeof fee.updatedAt === "string", JSON.stringify(fee?.payments));
  row = await CommissionFeeUpdateModel.findOne({ invoiceId: a1 }).lean();
  check("…and the row says delivered", row?.state === "delivered" && row?.deliveredAt);

  feeMode.set(a1, "down");
  const lastPay = (await inv(a1)).payments.at(-1);
  await request("PATCH", `/invoices/${a1}/payments/${lastPay._id}`, { method: "card", amountMinor: 6_000, paidOn: dayOf(0) }, token);
  const before = feeUpdates.length;
  await drain();
  row = await CommissionFeeUpdateModel.findOne({ invoiceId: a1 }).lean();
  check("Tetra Commission down: kept, to try again later", row?.state === "pending" && row?.attempts === 1 && /down/.test(row?.lastError ?? "") && row!.nextAttemptAt! > new Date(), JSON.stringify(row));
  await drain();
  check("…not before its time", feeUpdates.length === before);
  feeMode.set(a1, "noroute");
  await drain(new Date(Date.now() + 3_600_000));
  row = await CommissionFeeUpdateModel.findOne({ invoiceId: a1 }).lean();
  check("a Tetra Commission without the route yet (404, no code): still retried", row?.state === "pending" && row?.attempts === 2, JSON.stringify(row));
  feeMode.set(a1, "ok");
  await drain(new Date(Date.now() + 2 * 3_600_000));
  row = await CommissionFeeUpdateModel.findOne({ invoiceId: a1 }).lean();
  check("…and delivered once it is back, with the edit", row?.state === "delivered" && lastFeeFor(a1)?.paidMinor === 51_000, JSON.stringify(lastFeeFor(a1)));

  feeMode.set(a1, "unknown");
  await request("POST", `/invoices/${a1}/payments`, { method: "cash", amountMinor: 1_000, paidOn: dayOf(0) }, token);
  await drain();
  row = await CommissionFeeUpdateModel.findOne({ invoiceId: a1 }).lean();
  check("404 UNKNOWN_INVOICE: stopped", row?.state === "stopped" && row?.lastError === "No course fee for this invoice", JSON.stringify(row));
  const calls = feeUpdates.length;
  await drain(new Date(Date.now() + 10 * 3_600_000));
  check("…and not tried again", feeUpdates.length === calls);
  feeMode.set(a1, "ok");
  await request("POST", `/invoices/${a1}/payments`, { method: "cash", amountMinor: 1_000, paidOn: dayOf(0) }, token);
  await drain();
  check("…until the money changes again", (await CommissionFeeUpdateModel.findOne({ invoiceId: a1 }).lean())?.state === "delivered" && lastFeeFor(a1)?.paidMinor === 53_000);

  // Tetra Commission already has something newer: a 200 all the same, so done.
  feeMode.set(a1, "older");
  await request("POST", `/invoices/${a1}/payments`, { method: "cash", amountMinor: 500, paidOn: dayOf(0) }, token);
  await drain();
  check("200 { applied: false, ignored: older }: delivered, not retried", (await CommissionFeeUpdateModel.findOne({ invoiceId: a1 }).lean())?.state === "delivered");
  feeMode.set(a1, "ok");
  await request("DELETE", `/invoices/${a1}/payments/${(await inv(a1)).payments.at(-1)._id}`, undefined, token);
  await drain();

  // A change made while a send is on its way goes after it.
  feeMode.set(a1, "slow");
  await request("POST", `/invoices/${a1}/payments`, { method: "cash", amountMinor: 1_000, paidOn: dayOf(0) }, token);
  slowArrived = false;
  await settle();
  const pass = drainFeeUpdates();
  for (let i = 0; i < 50 && !slowArrived; i++) await settle(50);
  feeMode.set(a1, "ok");
  await request("POST", `/invoices/${a1}/payments`, { method: "cash", amountMinor: 1_000, paidOn: dayOf(0) }, token);
  await settle();
  releaseSlow?.();
  await pass;
  row = await CommissionFeeUpdateModel.findOne({ invoiceId: a1 }).lean();
  check("a change made mid-send leaves the row pending, with the newer picture", row?.state === "pending" && (row?.payload as any)?.paidMinor === 55_000, JSON.stringify(row));
  await drain();
  check("…which is sent next", lastFeeFor(a1)?.paidMinor === 55_000 && (await CommissionFeeUpdateModel.findOne({ invoiceId: a1 }).lean())?.state === "delivered");

  const c1 = await close({ paid: 30_000, paidOn: dayOf(-1) });
  await provision(c1);
  await request("POST", `/invoices/${c1}/void`, undefined, token);
  await drain();
  check("voided: status void, nothing due", lastFeeFor(c1)?.status === "void" && lastFeeFor(c1)?.nextDueOn === null, JSON.stringify(lastFeeFor(c1)));
  await request("POST", `/invoices/${c1}/restore`, undefined, token);
  await drain();
  check("restored: partial again, with its due date", lastFeeFor(c1)?.status === "partial" && lastFeeFor(c1)?.nextDueOn === plus(dayOf(-1), 29), JSON.stringify(lastFeeFor(c1)));

  const cn = await request("POST", "/credit-notes", { invoiceId: c1, reason: "Goodwill", lineItems: [{ description: "Goodwill", quantity: 1, unitPriceMinor: 10_000 }] }, token);
  const cnId = String(cn.body?.data?.id ?? "");
  await request("POST", `/credit-notes/${cnId}/issue`, undefined, token);
  r = await request("POST", `/credit-notes/${cnId}/apply`, {}, token);
  await settle();
  await drain();
  check("a credit note applied: sent too", r.status < 300 && lastFeeFor(c1)?.balanceMinor === 60_000, `${show(r)} ${JSON.stringify(lastFeeFor(c1))}`);

  const c2 = await close({ paid: 0 });
  await provision(c2);
  await request("POST", `/invoices/${c2}/void`, undefined, token);
  r = await request("DELETE", `/invoices/${c2}`, undefined, token);
  await settle();
  await drain();
  check("deleted: status deleted", r.status < 300 && lastFeeFor(c2)?.status === "deleted" && !(await inv(c2)), `${show(r)} ${JSON.stringify(lastFeeFor(c2))}`);

  const c3 = await close({ paid: 20_000, paidOn: dayOf(0) });
  await provision(c3, { commission: "pending" });
  await drainCommissionStudents();
  await settle();
  row = await CommissionFeeUpdateModel.findOne({ invoiceId: c3 }).lean();
  check("the moment a student is sent there, their figures and due date follow", row?.reason === "sent to Tetra Commission" && (row?.payload as any)?.nextDueOn === dayOf(29), JSON.stringify(row));
  await drain();

  /* ── D ── */
  step("D. Client reminders 3, 2 and 1 day before");
  // Paid six days ago, so no other invoice here shares its due date.
  const r1 = await close({ paid: 40_000, paidOn: dayOf(-6), course: "Delta Wave Theory" });
  await provision(r1);
  const due = plus(dayOf(-6), 29);
  check("due 29 days after it was paid", iso((await inv(r1)).dueDate) === due);
  // Due the same day but not to be reminded: another programme, no LMS row, paid, void.
  const notForex = await close({ paid: 40_000, paidOn: dayOf(-6) });
  await provision(notForex, { program: "digital-marketing", commission: "skipped" });
  const noRow = await close({ paid: 40_000, paidOn: dayOf(-6) });
  const paidUp = await close({ fee: 40_000, paid: 40_000 });
  await provision(paidUp);
  await Invoice.updateOne({ _id: paidUp }, { $set: { dueDate: new Date(`${due}T00:00:00.000Z`) } });
  const voided = await close({ paid: 40_000, paidOn: dayOf(-6) });
  await provision(voided);
  await request("POST", `/invoices/${voided}/void`, undefined, token);
  await Invoice.updateOne({ _id: voided }, { $set: { dueDate: new Date(`${due}T00:00:00.000Z`) } });
  const emailOf = async (id: string) => `client${(await inv(id)).customerName.replace("Client ", "")}@e2e-test.com`;
  const mailTo = async (id: string) => { const e = await emailOf(id); return caught.filter((m) => m.to.includes(e)); };

  let run = await runInstalmentReminders(uaeTen(plus(due, -4)));
  check("4 days before: nothing", run.sent === 0 && (await mailTo(r1)).length === 0, JSON.stringify(run));
  // 20:30 UTC is 00:30 the next day in the UAE: 3 days before there.
  run = await runInstalmentReminders(new Date(`${plus(due, -4)}T20:30:00.000Z`));
  let mine = await mailTo(r1);
  check("3 days before (by the UAE day): the client is reminded", run.sent === 1 && mine.length === 1, `${JSON.stringify(run)} ${caught.map((c) => c.to).join(";")}`);
  const r1Doc = await inv(r1);
  const body3 = plain(mine[0]?.body ?? "");
  check("…of the balance, the course, the date and the invoice", /Delta Wave Theory/.test(mine[0]?.subject ?? "") && /in 3 days/.test(mine[0]?.subject ?? "")
    && body3.includes("AED 600.00") && body3.includes(r1Doc.invoiceNumber) && body3.includes("accounts@e2e-test.com"), `${mine[0]?.subject} :: ${body3.slice(0, 200)}`);
  check("…from Delta Finance", /From: .*Delta Finance/i.test(mine[0]?.body ?? ""), (mine[0]?.body ?? "").slice(0, 200));
  run = await runInstalmentReminders(uaeTen(plus(due, -3)));
  check("the same day again: not twice", run.sent === 0 && run.already === 1 && (await mailTo(r1)).length === 1, JSON.stringify(run));
  await runInstalmentReminders(uaeTen(plus(due, -2)));
  await runInstalmentReminders(uaeTen(plus(due, -1)));
  mine = await mailTo(r1);
  check("2 and 1 day before: one each", mine.length === 3 && /in 2 days/.test(mine[1]!.subject) && /tomorrow/.test(mine[2]!.subject), mine.map((m) => m.subject).join(" | "));
  await runInstalmentReminders(uaeTen(due));
  await runInstalmentReminders(uaeTen(plus(due, 1)));
  check("on the day and after: nothing more", (await mailTo(r1)).length === 3);
  check("never for another programme, no LMS row, paid or void", (await mailTo(notForex)).length === 0 && (await mailTo(noRow)).length === 0
    && (await mailTo(paidUp)).length === 0 && (await mailTo(voided)).length === 0);
  const logged = await EmailLog.find({ kind: "instalment_reminder" }).lean();
  check("each in the email log as an instalment reminder", logged.length === 3 && logged.every((l: any) => l.state === "sent" && String(l.ref?.id) === r1), JSON.stringify(logged.map((l: any) => l.state)));
  check("…and claimed once each", (await InstalmentReminder.countDocuments({ invoiceId: r1 })) === 3);

  await request("POST", `/invoices/${r1}/payments`, { method: "cash", amountMinor: 10_000, paidOn: plus(due, -1) }, token);
  const due2 = plus(due, 28);
  check("another payment: a new due date", iso((await inv(r1)).dueDate) === due2, iso((await inv(r1)).dueDate));
  await runInstalmentReminders(uaeTen(plus(due2, -3)));
  mine = await mailTo(r1);
  check("…whose reminders come round again, with the new balance", mine.length === 4 && plain(mine[3]!.body).includes("AED 500.00"), plain(mine[3]?.body ?? "").slice(0, 300));
  await request("POST", `/invoices/${r1}/payments`, { method: "cash", amountMinor: 50_000, paidOn: plus(due2, -3) }, token);
  await runInstalmentReminders(uaeTen(plus(due2, -2)));
  check("paid in full: no more", (await mailTo(r1)).length === 4);

  /* ── E ── */
  step("E. A balance payment a CS records in Tetra Commission");
  const e1 = await close({ fee: 100_000, paid: 30_000, paidOn: dayOf(-10) });
  await provision(e1);
  const e1Doc = await inv(e1);
  const student = { id: "tc-student-1", code: "STU-0001", name: e1Doc.customerName, email: "client@e2e-test.com", level: "LEVEL_1" };
  const pay = (over: Record<string, unknown>) => signedPost(HQ, "/api/v1/integrations/tetra-deposits", {
    type: "ENROLMENT_PAYMENT", amountMinor: 20_000, currency: "AED", student, requestedBy: "Casey CS", ...over,
  });
  r = await pay({ externalId: "tc-pay-1", invoiceId: e1, method: "Cash", paidOn: dayOf(-1), receiptUrl: "https://files.e2e-test.com/r/1.jpg", csName: "Casey CS", csEmail: "casey@e2e-test.com" });
  const p1 = r.body?.data;
  check("taken in, flat as Tetra Commission may send it", r.status === 200 && p1?.type === "ENROLMENT_PAYMENT" && p1?.status === "pending"
    && p1?.enrolmentPayment?.invoiceNumber === e1Doc.invoiceNumber && p1?.enrolmentPayment?.cs?.email === "casey@e2e-test.com"
    && p1?.enrolmentPayment?.invoice?.balanceMinor === 70_000 && p1?.enrolmentPayment?.paidOn === dayOf(-1), show(r));
  r = await pay({ externalId: "tc-pay-1", invoiceId: e1, method: "Cash", paidOn: dayOf(-1) });
  check("a retry is the same request", r.status === 200 && r.body?.data?.id === p1?.id && (await TetraDepositModel.countDocuments({ externalId: "tc-pay-1" })) === 1);
  r = await pay({ externalId: "tc-pay-x", amountMinor: 80_000, invoiceId: e1, method: "Cash", paidOn: dayOf(-1) });
  check("more than the balance: refused with why", r.status === 409 && /more than the balance/.test(JSON.stringify(r.body)), show(r));
  r = await pay({ externalId: "tc-pay-y", currency: "USD", invoiceId: e1, method: "Cash", paidOn: dayOf(-1) });
  check("another currency: refused", r.status === 409 && /in AED/.test(JSON.stringify(r.body)), show(r));
  r = await pay({ externalId: "tc-pay-z", invoiceId: a3, method: "Cash", paidOn: dayOf(-1) });
  check("an invoice whose student finance never sent there: refused", r.status === 422 && /not sent to Tetra Commission/.test(JSON.stringify(r.body)), show(r));
  r = await pay({ externalId: "tc-pay-w", invoiceId: new Types.ObjectId().toString(), method: "Cash", paidOn: dayOf(-1) });
  check("an invoice finance does not have: refused", r.status === 404, show(r));
  r = await pay({ externalId: "tc-pay-v", invoiceId: e1, method: "Cash" });
  check("no date paid: refused", r.status === 422, show(r));
  r = await pay({ externalId: "tc-pay-2", amountMinor: 1_000, enrolmentPayment: { invoiceId: e1, method: "Card", paidOn: dayOf(-3), cs: { name: "Casey CS", email: "casey@e2e-test.com" } } });
  const p2 = r.body?.data;
  check("…and nested under enrolmentPayment too", r.status === 200 && p2?.enrolmentPayment?.method === "Card", show(r));
  const queue = await request("GET", "/tetra-deposits?view=waiting", undefined, token);
  check("both on the accountants' Approvals queue", (queue.body?.data ?? []).filter((x: any) => x.type === "ENROLMENT_PAYMENT").length === 2, show(queue));

  r = await request("POST", `/tetra-deposits/${p2.id}/decision`, { decision: "approved", amountMinor: 75_000, transactionId: "TXN-2" }, token);
  check("approved for more than the balance: refused, still pending", r.status === 409 && /more than the balance/.test(JSON.stringify(r.body))
    && (await TetraDepositModel.findById(p2.id).lean())?.status === "pending" && (await inv(e1)).payments.length === 1, show(r));

  const decisionsBefore = decisions.length;
  r = await request("POST", `/tetra-deposits/${p1.id}/decision`, { decision: "approved", amountMinor: 20_000, transactionId: "TXN-1", paymentMethod: "" }, token);
  check("approved: delivered", r.status === 200 && r.body?.data?.delivered === true && /recorded on invoice/.test(r.body?.data?.message ?? ""), show(r));
  d = await inv(e1);
  const recorded = (d.payments as any[]).find((p) => p.externalRef === "tetra:tc-pay-1");
  check("…recorded on the invoice: amount, date paid, method, reference, receipt", recorded?.amountMinor === 20_000 && iso(recorded?.paidOn) === dayOf(-1)
    && recorded?.method === "cash" && recorded?.reference === "TXN-1" && recorded?.proofUrl === "https://files.e2e-test.com/r/1.jpg" && /Casey CS/.test(recorded?.notes), JSON.stringify(recorded));
  check("…the balance down and the next due date from it", d.amountPaidMinor === 50_000 && d.balanceMinor === 50_000 && iso(d.dueDate) === plus(dayOf(-1), 29), `${d.amountPaidMinor}/${d.balanceMinor}/${iso(d.dueDate)}`);
  const decision = decisions.slice(decisionsBefore).find((x) => x.fundingId === "tc-pay-1");
  check("…the decision back to Tetra Commission, naming the invoice and the payment", decision?.decision === "approved" && decision?.type === "ENROLMENT_PAYMENT"
    && decision?.invoiceId === e1 && decision?.paymentId === String(recorded?._id) && decision?.amountMinor === 20_000 && decision?.paidOn === dayOf(-1), JSON.stringify(decision));
  await drain();
  check("…and the new figures follow as a fee update", lastFeeFor(e1)?.paidMinor === 50_000 && lastFeeFor(e1)?.nextDueOn === plus(dayOf(-1), 29), JSON.stringify(lastFeeFor(e1)));
  r = await request("POST", `/tetra-deposits/${p1.id}/decision`, { decision: "approved", amountMinor: 20_000, transactionId: "TXN-1" }, token);
  check("deciding it again: refused, nothing recorded twice", r.status === 409 && (await inv(e1)).payments.filter((p: any) => p.externalRef === "tetra:tc-pay-1").length === 1, show(r));
  r = await request("POST", `/tetra-deposits/${p2.id}/decision`, { decision: "approved", amountMinor: 1_500, transactionId: "TXN-2", paymentMethod: "bank_transfer" }, token);
  d = await inv(e1);
  const second = (d.payments as any[]).find((p) => p.externalRef === "tetra:tc-pay-2");
  check("the other, corrected and with finance's method chosen: recorded as corrected", r.status === 200 && second?.amountMinor === 1_500 && second?.method === "bank_transfer"
    && iso(d.dueDate) === plus(dayOf(-1), 29), `${show(r)} ${JSON.stringify(second)}`);
  r = await pay({ externalId: "tc-pay-3", amountMinor: 1_000, invoiceId: e1, method: "Cash", paidOn: dayOf(0) });
  r = await request("POST", `/tetra-deposits/${r.body?.data?.id}/decision`, { decision: "rejected", reason: "No such transfer on the statement" }, token);
  check("rejected: nothing recorded, the rejection sent back", r.status === 200 && !(await inv(e1)).payments.some((p: any) => p.externalRef === "tetra:tc-pay-3")
    && decisions.some((x) => x.fundingId === "tc-pay-3" && x.decision === "rejected"), show(r));

  // Exactly as Tetra Commission's Balance payments page sends it (its coursePayments-style queue).
  const tcShape = {
    externalId: new Types.ObjectId().toString(), type: "ENROLMENT_PAYMENT", amountMinor: 3_000, currency: "AED",
    invoiceId: e1, invoiceNumber: e1Doc.invoiceNumber, course: "Delta Wave Theory", method: "Bank transfer", paidOn: dayOf(0),
    receiptUrl: "https://files.e2e-test.com/r/tc.jpg", receiptName: "tc.jpg", cs: { name: "Casey CS", email: "casey@e2e-test.com" },
    enrolmentPayment: {
      invoiceId: e1, invoiceNumber: e1Doc.invoiceNumber, course: "Delta Wave Theory", amountMinor: 3_000, currency: "AED",
      method: "Bank transfer", paidOn: dayOf(0), receiptUrl: "https://files.e2e-test.com/r/tc.jpg", receiptName: "tc.jpg",
      balanceMinor: 48_500, cs: { name: "Casey CS", email: "casey@e2e-test.com" },
    },
    student, team: "Chief One", paymentMethod: "Bank transfer", screenshotUrl: "https://files.e2e-test.com/r/tc.jpg",
    notes: "Balance payment · paid on today", requestedAt: new Date().toISOString(), requestedBy: "Casey CS", primaryMentor: "Casey CS",
  };
  r = await signedPost(HQ, "/api/v1/integrations/tetra-deposits", tcShape);
  const tcRow = r.body?.data;
  check("Tetra Commission's own payload is taken as it is", r.status === 200 && tcRow?.type === "ENROLMENT_PAYMENT" && tcRow?.externalId === tcShape.externalId
    && tcRow?.enrolmentPayment?.method === "Bank transfer" && tcRow?.enrolmentPayment?.receiptName === "tc.jpg" && tcRow?.enrolmentPayment?.cs?.name === "Casey CS", show(r));
  r = await request("POST", `/tetra-deposits/${tcRow?.id}/decision`, { decision: "approved", amountMinor: 3_000, transactionId: "TXN-TC" }, token);
  const tcDecision = decisions.find((x) => x.fundingId === tcShape.externalId);
  check("…approved: recorded as a bank transfer, and the decision goes back under its externalId", r.status === 200
    && (await inv(e1)).payments.some((p: any) => p.externalRef === `tetra:${tcShape.externalId}` && p.method === "bank_transfer" && p.amountMinor === 3_000)
    && tcDecision?.decision === "approved" && tcDecision?.type === "ENROLMENT_PAYMENT" && tcDecision?.invoiceId === e1, `${show(r)} ${JSON.stringify(tcDecision)}`);

  // An approval that died after it was claimed, before the payment was recorded: the worker finishes it.
  r = await pay({ externalId: "tc-pay-4", amountMinor: 2_000, invoiceId: e1, method: "Card", paidOn: dayOf(0) });
  await TetraDepositModel.updateOne({ _id: r.body?.data?.id }, {
    $set: { status: "approved", decision: { approvedAmountMinor: 2_000, transactionId: "TXN-4", decidedByName: "Accounts Admin", decidedAt: new Date() },
      delivery: { state: "sending", attempts: 0, claimedAt: new Date(Date.now() - 10 * 60_000) } },
  });
  await drainTetraDepositDecisions();
  const p4 = await TetraDepositModel.findById(r.body?.data?.id).lean() as any;
  check("an approval that died part-way: the worker records it, then delivers it", (await inv(e1)).payments.some((p: any) => p.externalRef === "tetra:tc-pay-4" && p.amountMinor === 2_000)
    && p4?.enrolmentPayment?.recorded?.paymentId && p4?.delivery?.state === "delivered" && decisions.some((x) => x.fundingId === "tc-pay-4"), JSON.stringify(p4?.delivery));

  // As the Banglore CRM's close leaves one in Bangalore's books (in INR).
  const sally = await User.findOne({ email: "sally@e2e-test.com" }).lean();
  const b1 = String((await Invoice.create({
    organizationId: blr.org._id, invoiceNumber: "BLR-00001", customerId: new Types.ObjectId(), customerName: "Bangalore Client",
    salespersonId: sally!._id, salespersonName: "Sally Sales", issueDate: new Date(), dueDate: new Date(), currency: "INR",
    totalMinor: 5_000_000, amountPaidMinor: 1_000_000, balanceMinor: 4_000_000, status: "partial",
    approval: { state: "approved" }, external: { source: "crm", externalId: "blr-1" },
    enrolment: { course: "Delta Wave Theory", modeOfStudy: "online", language: "English" },
    payments: [{ method: "inr_bank_account", amountMinor: 1_000_000, paidOn: new Date() }],
  }))._id);
  await provision(b1);
  r = await signedPost(HQ, "/api/v1/integrations/tetra-deposits", {
    type: "ENROLMENT_PAYMENT", externalId: "tc-pay-blr", amountMinor: 500_000, currency: "INR", student, invoiceId: b1, method: "UPI", paidOn: dayOf(-1),
  });
  const blrRow = await TetraDepositModel.findOne({ externalId: "tc-pay-blr" }).lean();
  check("a Bangalore enrolment's payment, through Delta HQ's link: decided by Bangalore's accounts", r.status === 200 && String(blrRow?.organizationId) === String(blr.org._id), show(r));

  /* ── F ── */
  step("F. The one-off backfill");
  const f1 = await close({ paid: 30_000, paidOn: dayOf(-4) });
  await provision(f1);
  const f2 = await close({ paid: 30_000, paidOn: dayOf(-4) });
  await provision(f2, { program: "digital-marketing", commission: "skipped" });
  // As enrolments approved before 2026-10-11 were left: due the day of the close.
  await Invoice.updateMany({ _id: { $in: [f1, f2] } }, { $set: { dueDate: new Date(`${dayOf(-3)}T00:00:00.000Z`) } });
  await CommissionFeeUpdateModel.deleteMany({ invoiceId: { $in: [f1, f2] } });
  let rows = await backfillInstalmentDue({ write: false });
  const f1No = (await inv(f1)).invoiceNumber;
  const f2No = (await inv(f2)).invoiceNumber;
  check("read-only: lists the Forex one with its new date", rows.some((x) => x.invoiceNumber === f1No && x.from === dayOf(-3) && x.to === plus(dayOf(-4), 29) && x.toCommission)
    && iso((await inv(f1)).dueDate) === dayOf(-3), JSON.stringify(rows));
  check("…not the other programme's", !rows.some((x) => x.invoiceNumber === f2No));
  check("…and changes nothing", (await CommissionFeeUpdateModel.countDocuments({ invoiceId: f1 })) === 0);
  rows = await backfillInstalmentDue({ write: true });
  check("--write: the date set and Tetra Commission's update queued", iso((await inv(f1)).dueDate) === plus(dayOf(-4), 29)
    && (await CommissionFeeUpdateModel.findOne({ invoiceId: f1 }).lean())?.state === "pending" && iso((await inv(f2)).dueDate) === dayOf(-3), JSON.stringify(rows));
  rows = await backfillInstalmentDue({ write: true });
  check("run again: nothing left to do", rows.length === 0, JSON.stringify(rows));

  console.log(`\n${checks - failures}/${checks} checks passed`);
  await mongoose.disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
