/**
 * Balance payments from the sales CRMs (the user, 2026-10-13), over real HTTP
 * against a real API process:
 *
 *   A. Intake (signed, as a CRM sends it): checked against the invoice — void,
 *      not approved, paid in full, more than is left (with what already waits)
 *      refused; the same id twice is the same payment; another CRM's enrolment
 *      is not found.
 *   B. Approved on the Approvals page: recorded on the invoice on the day it was
 *      paid, with its receipt as proof and an RCT receipt number; the next due
 *      date follows; decided once only.
 *   C. Rejected with a reason (too short refused); nothing recorded.
 *   D. The enrolment's status answers the CRM: course, next due date, every
 *      payment, and each balance payment pending / approved / rejected.
 *   E. The Approvals page: the kind in the summary and the list, searchable;
 *      a salesperson here cannot read or decide one.
 *
 * Run through scripts/balance-payments-e2e.sh. Scratch database only.
 */
import crypto from "node:crypto";
import mongoose, { Types } from "mongoose";
import { SYSTEM_ROLES } from "@delta/shared";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri) || /:27017\//.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1 (not 27017), got "${uri}"`);
  process.exit(1);
}

const { hashPassword } = await import("../lib/password");
const { Organization } = await import("../modules/organization/organization.model");
const { Role } = await import("../modules/role/role.model");
const { User } = await import("../modules/user/user.model");
const { Invoice } = await import("../modules/invoice/invoice.model");
const { BalancePaymentModel } = await import("../modules/balance-payment/balance-payment.model");

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

const DAY = 86_400_000;
const today = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
const dayOf = (offset: number) => new Date(today.getTime() + offset * DAY).toISOString().slice(0, 10);
const plus = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00.000Z`) + n * DAY).toISOString().slice(0, 10);
const iso = (d: unknown) => (d ? new Date(d as string).toISOString().slice(0, 10) : "");

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
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await mongoose.connect(uri);
  if (mongoose.connection.host !== "127.0.0.1") throw new Error("not 127.0.0.1");
  await mongoose.connection.dropDatabase();

  step("Setting up");
  const org = await Organization.create({ name: "Delta HQ E2E", baseCurrency: "AED", email: "accounts@e2e-test.com", phone: "+971 4 000 0000", taxRates: [{ label: "VAT 5%", code: "VAT", rate: 5, isDefault: true, appliesTo: "sales" }] });
  for (const def of SYSTEM_ROLES) {
    await Role.create({ organizationId: org._id, key: def.key, name: def.name, description: def.description, permissions: def.permissions, isSystem: true });
  }
  const roles = await Role.find({ organizationId: org._id }).lean();
  const roleId = (key: string) => new Types.ObjectId(String(roles.find((r) => r.key === key)!._id));
  const passwordHash = await hashPassword(PASSWORD);
  await User.create({ name: "Accounts Admin", email: "accounts.admin@e2e-test.com", passwordHash, status: "active", memberships: [{ organizationId: org._id, roleId: roleId("admin"), status: "active" }] });
  await User.create({ name: "Sally Sales", email: "sally@e2e-test.com", passwordHash, status: "active", memberships: [{ organizationId: org._id, roleId: roleId("salesperson"), status: "active" }] });
  const token = (await request("POST", "/auth/login", { email: "accounts.admin@e2e-test.com", password: PASSWORD })).body?.data?.accessToken as string;
  const sallyToken = (await request("POST", "/auth/login", { email: "sally@e2e-test.com", password: PASSWORD })).body?.data?.accessToken as string;
  check("an accountant and a salesperson can sign in", Boolean(token && sallyToken));
  const HQ = String(org._id);

  let n = 0;
  /** A CRM close: `paid` declared as one payment on `paidOn`; approved unless told not to. */
  async function close(opts: { fee?: number; paid?: number; paidOn?: string; approve?: boolean; source?: string } = {}) {
    n++;
    const fee = opts.fee ?? 100_000;
    const paid = opts.paid ?? 40_000;
    const externalId = `bal-${n}`;
    const r = await signedPost(HQ, "/api/v1/integrations/enrolments", {
      externalId, source: opts.source ?? "crm", crm: "delta",
      customer: { name: `Client ${n}`, email: `client${n}@e2e-test.com`, phone: `+97150000${String(n).padStart(4, "0")}` },
      course: { name: "Market Breakout", amountMinor: fee },
      modeOfStudy: "online", language: "English", salespersonEmail: "sally@e2e-test.com", salespersonName: "Sally Sales",
      enrolledOn: dayOf(-10),
      declaredPaidMinor: paid,
      ...(paid > 0 ? { declaredPaymentMethod: "cash", payments: [{ method: "cash", amountMinor: paid, paidOn: opts.paidOn ?? dayOf(-9) }] } : {}),
    });
    const id = String(r.body?.data?.invoiceId ?? "");
    if (!id) throw new Error(`enrolment refused: ${show(r)}`);
    if (opts.approve !== false) {
      const a = await request("POST", `/invoices/${id}/approval/approve`, undefined, token);
      if (a.status !== 200) throw new Error(`approval refused: ${show(a)}`);
    }
    return { id, externalId };
  }
  const inv = async (id: string) => (await Invoice.findById(id).lean()) as any;
  let m = 0;
  const receipt = { name: "receipt.jpg", url: "https://files.e2e-test.com/receipts/r.jpg", key: "receipts/r.jpg", mimeType: "image/jpeg" };
  const pay = (enrolmentExternalId: string, amountMinor: number, extra: Record<string, unknown> = {}) =>
    signedPost(HQ, "/api/v1/integrations/enrolments/balance-payments", {
      source: "crm", enrolmentExternalId, externalId: `pay-${++m}`, amountMinor, method: "bank_transfer", paidOn: dayOf(-1),
      receipt, note: "Second instalment", recordedBy: { name: "Sally Sales", email: "sally@e2e-test.com" }, ...extra,
    });
  const statusOf = async (externalId: string, source = "crm") =>
    (await signedPost(HQ, "/api/v1/integrations/enrolments/status", { source, externalIds: [externalId] })).body?.data?.[0];

  /* ── A ── */
  step("A. Intake");
  const a = await close();
  let r = await pay(a.externalId, 20_000);
  const p1 = r.body?.data;
  check("received: pending, on the invoice, with the receipt and who recorded it", r.status < 300 && p1?.status === "pending"
    && p1?.invoiceId === a.id && p1?.amountMinor === 20_000 && p1?.currency === "AED" && p1?.receipt?.url === receipt.url
    && p1?.recordedBy?.name === "Sally Sales" && p1?.course === "Market Breakout" && p1?.customerName === "Client 1", show(r));
  const again = await signedPost(HQ, "/api/v1/integrations/enrolments/balance-payments", {
    source: "crm", enrolmentExternalId: a.externalId, externalId: "pay-1", amountMinor: 20_000, method: "bank_transfer", paidOn: dayOf(-1),
    receipt, recordedBy: { name: "Sally Sales", email: "" },
  });
  check("the same id again: the same payment, not a second", again.body?.data?.id === p1?.id && (await BalancePaymentModel.countDocuments()) === 1, show(again));
  r = await pay(a.externalId, 50_000);
  check("more than is left once the one waiting counts: refused, saying so", r.status === 409 && /already waiting/.test(r.body?.error?.message ?? ""), show(r));
  r = await pay(a.externalId, 70_000);
  check("…and the full balance alone too", r.status === 409, show(r));
  const unapproved = await close({ approve: false });
  r = await pay(unapproved.externalId, 10_000);
  check("an enrolment not approved yet: refused", r.status === 409 && /not approved/.test(r.body?.error?.message ?? ""), show(r));
  const full = await close({ fee: 50_000, paid: 50_000 });
  r = await pay(full.externalId, 1_000);
  check("paid in full: refused", r.status === 409 && /paid in full/.test(r.body?.error?.message ?? ""), show(r));
  const voided = await close();
  await Invoice.updateOne({ _id: voided.id }, { $set: { status: "void" } });
  r = await pay(voided.externalId, 1_000);
  check("void: refused", r.status === 409 && /void/.test(r.body?.error?.message ?? ""), show(r));
  r = await pay("nobody-sent-this", 1_000);
  check("an enrolment finance never had: not found", r.status === 404, show(r));
  r = await pay(a.externalId, 1_000, { source: "draw-crm" });
  check("another CRM cannot pay towards this CRM's enrolment", r.status === 404, show(r));
  r = await pay(a.externalId, 1_000, { receipt: undefined });
  check("no receipt: refused", r.status === 422, show(r));
  check("only the one payment is waiting", (await BalancePaymentModel.countDocuments({ status: "pending" })) === 1);

  /* ── B ── */
  step("B. Approved");
  r = await request("POST", `/balance-payments/${p1.id}/decision`, { decision: "approved", reference: "BANK-778" }, sallyToken);
  check("a salesperson here cannot decide it", r.status === 403, show(r));
  r = await request("GET", `/balance-payments/${p1.id}`, undefined, token);
  check("the accountant reads it with the invoice as it stands", r.body?.data?.invoice?.balanceMinor === 60_000 && r.body?.data?.invoice?.paidMinor === 40_000, show(r));
  r = await request("POST", `/balance-payments/${p1.id}/decision`, { decision: "approved", reference: "BANK-778", note: "Checked" }, token);
  const approved = r.body?.data;
  check("approved: with a receipt number and who approved it", r.status === 200 && approved?.status === "approved"
    && /^RCT-/.test(approved?.decision?.receiptNumber ?? "") && approved?.decision?.decidedByName === "Accounts Admin", show(r));
  let d = await inv(a.id);
  const rec = (d.payments as any[]).find((p) => p.externalRef === `crm-balance:${p1.id}`);
  check("recorded on the invoice: amount, method, the day it was paid, the receipt as proof", rec?.amountMinor === 20_000
    && rec?.method === "bank_transfer" && iso(rec?.paidOn) === dayOf(-1) && rec?.proofUrl === receipt.url && rec?.reference === "BANK-778"
    && rec?.receiptNumber === approved?.decision?.receiptNumber, JSON.stringify(rec));
  check("the invoice moves: 60,000 paid, 40,000 left, next due 29 days after it was paid",
    d.amountPaidMinor === 60_000 && d.balanceMinor === 40_000 && iso(d.dueDate) === plus(dayOf(-1), 29), `${d.amountPaidMinor} ${d.balanceMinor} ${iso(d.dueDate)}`);
  r = await request("POST", `/balance-payments/${p1.id}/decision`, { decision: "approved" }, token);
  d = await inv(a.id);
  check("decided once: a second approval is refused, nothing recorded twice", r.status === 409 && (d.payments as any[]).filter((p) => p.externalRef === `crm-balance:${p1.id}`).length === 1, show(r));

  // Recorded on the invoice meanwhile, by accounts themselves: the waiting one no longer fits.
  r = await pay(a.externalId, 30_000);
  const p2 = r.body?.data;
  await request("POST", `/invoices/${a.id}/payments`, { method: "cash", amountMinor: 20_000, paidOn: dayOf(0) }, token);
  r = await request("POST", `/balance-payments/${p2.id}/decision`, { decision: "approved" }, token);
  const p2Row = await BalancePaymentModel.findById(p2.id).lean();
  check("no longer fits the balance: not recorded, still waiting, for a person to reject", r.status === 409 && /Not recorded/.test(r.body?.error?.message ?? "")
    && p2Row?.status === "pending" && !p2Row?.decision, show(r));

  /* ── C ── */
  step("C. Rejected");
  r = await request("POST", `/balance-payments/${p2.id}/decision`, { decision: "rejected", reason: "no" }, token);
  check("a reason under 5 characters: refused", r.status === 422, show(r));
  r = await request("POST", `/balance-payments/${p2.id}/decision`, { decision: "rejected", reason: "Receipt does not match the bank statement" }, token);
  d = await inv(a.id);
  check("rejected with why; nothing recorded", r.body?.data?.status === "rejected" && r.body?.data?.decision?.reason === "Receipt does not match the bank statement"
    && !(d.payments as any[]).some((p) => p.externalRef === `crm-balance:${p2.id}`), show(r));
  r = await request("POST", `/balance-payments/${p2.id}/decision`, { decision: "approved" }, token);
  check("…and cannot be approved after", r.status === 409, show(r));

  /* ── D ── */
  step("D. The status the CRM reads");
  const pend = (await pay(a.externalId, 5_000)).body?.data;
  const s = await statusOf(a.externalId);
  check("course and next due date", s?.course === "Market Breakout" && s?.nextDueOn === plus(dayOf(0), 29) && s?.balanceMinor === 20_000, JSON.stringify(s).slice(0, 300));
  check("every payment on the invoice, with the receipt number where there is one", s?.payments?.length === 3
    && s.payments.some((p: any) => p.amountMinor === 20_000 && p.receiptNumber === approved?.decision?.receiptNumber && p.paidOn === dayOf(-1)), JSON.stringify(s?.payments));
  const bp = s?.balancePayments ?? [];
  check("each balance payment it sent, with where it stands", bp.length === 3
    && bp[0].externalId === "pay-1" && bp[0].status === "approved" && bp[0].receiptNumber === approved?.decision?.receiptNumber && bp[0].decidedBy === "Accounts Admin"
    && bp[1].status === "rejected" && bp[1].reason === "Receipt does not match the bank statement"
    && bp[2].status === "pending" && !bp[2].decidedAt, JSON.stringify(bp));
  const sFull = await statusOf(full.externalId);
  check("paid in full: no next due date, no balance payments", sFull?.nextDueOn === "" && sFull?.balancePayments?.length === 0, JSON.stringify(sFull).slice(0, 200));
  const sVoid = await statusOf(voided.externalId);
  check("void: no next due date", sVoid?.nextDueOn === "", JSON.stringify(sVoid).slice(0, 200));

  /* ── E ── */
  step("E. The Approvals page");
  await settle();
  r = await request("GET", "/approvals/summary", undefined, token);
  const group = (r.body?.data?.groups ?? []).find((g: any) => g.type === "balance_payment");
  check("in the summary: one waiting", group?.count === 1, show(r));
  r = await request("GET", "/approvals/list?type=balance_payment&status=pending", undefined, token);
  const row = r.body?.data?.[0];
  check("in the list: the client, decided here, raised by the salesperson", r.body?.data?.length === 1 && row?.id === pend.id
    && row?.title === "Client 1" && row?.decideHere === true && row?.raisedBy === "Sally Sales" && row?.amountMinor === 5_000, show(r));
  r = await request("GET", "/approvals/list?type=balance_payment&status=all", undefined, token);
  check("all three, with their states", r.body?.data?.length === 3 && new Set(r.body.data.map((x: any) => x.status)).size === 3, show(r));
  r = await request("GET", `/approvals/list?status=all&q=${encodeURIComponent(d.invoiceNumber)}`, undefined, token);
  check("searchable by the invoice number", (r.body?.data ?? []).some((x: any) => x.type === "balance_payment"), show(r));
  r = await request("GET", "/approvals/raisers", undefined, token);
  check("Sally among who raised them", (r.body?.data ?? []).includes("Sally Sales"), show(r));
  r = await request("GET", "/approvals/list?type=balance_payment&status=all", undefined, sallyToken);
  check("a salesperson here sees none", (r.body?.data ?? []).length === 0, show(r));
  r = await request("GET", `/balance-payments/${pend.id}`, undefined, sallyToken);
  check("…nor reads one", r.status === 403, show(r));

  console.log(`\n${checks - failures}/${checks} checks passed`);
  await mongoose.disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
