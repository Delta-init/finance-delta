/**
 * A CS Portal bonus approved here, sent back to recheck (the user, 2026-11-19: "send back to sales or send back to
 * finance" — a broker admin found AED 2,250 requested where the receipt shows 4,500):
 *
 *   1. Refused, with a plain reason: finance never had it (404), not a bonus, not approved, its decision not yet
 *      with CS Portal, a malformed body.
 *   2. The broker admin's recheck (POST /integrations/tetra-deposits/recheck, signed): back to pending, its payment
 *      off the invoice, the approval it replaces kept, an event; the same key again changes nothing, another key is
 *      refused while it waits; a re-sent intake still answers the row as it is; the Approvals row says why.
 *   3. Approved again (at the right amount): a new payment on the invoice, once.
 *   4. The CS's correction after the broker admin sent it to them: the amount, course payment and receipt replaced.
 *   5. A reconciled payment: not sent back, nothing changed.
 *
 * Run through scripts/tetra-recheck-e2e.sh. Scratch databases only.
 */
import crypto from "node:crypto";
import mongoose, { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri) || /:27017\//.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1 (not 27017), got "${uri}"`);
  process.exit(1);
}

const { inboundTetraDepositSchema } = await import("@delta/shared");
const { Organization } = await import("../modules/organization/organization.model");
const { User } = await import("../modules/user/user.model");
const { Invoice } = await import("../modules/invoice/invoice.model");
const { TetraDepositModel } = await import("../modules/tetra-deposit/tetra-deposit.model");
const svc = await import("../modules/tetra-deposit/tetra-deposit.service");
const { recordCoursePayment } = await import("../modules/tetra-deposit/course-invoice");
const { approvalList } = await import("../modules/approvals/approvals.service");

const ORIGIN = `http://127.0.0.1:${process.env.E2E_API_PORT}`;
const INBOUND_ID = process.env.INBOUND_CLIENT_ID ?? "";
const INBOUND_SECRET = process.env.INBOUND_INTEGRATION_SECRET ?? "";

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const j = (v: unknown) => JSON.stringify(v).slice(0, 500);

type Res = { status: number; body: Record<string, any> };
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
const RECHECK = "/api/v1/integrations/tetra-deposits/recheck";
const INTAKE = "/api/v1/integrations/tetra-deposits";
const messageOf = (r: Res) => String(r.body?.error?.message ?? r.body?.message ?? "");

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();

const org = await Organization.create({ name: "Delta HQ E2E", baseCurrency: "AED" });
const ORG = String(org._id);
const asha = await User.create({ name: "Asha Accountant", email: "asha@e2e-recheck.test", passwordHash: "x", status: "active", memberships: [{ organizationId: org._id, roleId: new Types.ObjectId(), status: "active" }] });
const auth = { userId: String(asha._id), organizationId: ORG, role: "accountant", permissions: ["tetra_deposit:approve"], isSuperAdmin: false };

const student = { id: new Types.ObjectId().toString(), code: "STU-9200", name: "Rahul Student", email: "rahul@e2e-recheck.test", level: "1", phone: "+971500000001" };
const cp = (extra: Record<string, unknown> = {}) => ({ product: "DSLP Offer", kind: "partial", withBonus: true, bonusUsd: 500, price: 20000, priceCurrency: "AED", paidBeforeAed: 0, paidTodayAed: 2250, balanceAed: 17750, paidOn: "2026-11-18", ...extra });
/** What CS Portal hands over for a bonus — its depositPayload. AED 2,250 = USD 613.08. */
const payload = (externalId: string, extra: Record<string, unknown> = {}) => ({
  externalId, type: "BONUS", amountMinor: 61_308, currency: "USD", student, requestedBy: "Cara CS",
  paymentMethod: "Card", screenshotUrl: "https://files.e2e.test/receipt-1.png", coursePayment: cp(), mt5Login: "500100", ...extra,
});
let keyN = 0;
const recheckOf = (extra: Record<string, unknown> = {}) => ({ key: `rk-${++keyN}`, from: "broker_admin", byName: "Raneesh Broker", fields: ["amount", "receipt"], note: "Requested AED 2,250; the receipt shows 4,500", ...extra });

/** A bonus as CS Portal hands it over, approved here, put on its invoice and delivered — as decideTetraDeposit does. */
async function approvedBonus(extra: Record<string, unknown> = {}, cpExtra: Record<string, unknown> = {}) {
  const input = inboundTetraDepositSchema.parse(payload(new Types.ObjectId().toString(), { coursePayment: cp(cpExtra), ...extra }));
  const d = await svc.intakeTetraDeposit(ORG, input);
  await TetraDepositModel.updateOne({ _id: d.id }, {
    $set: {
      status: "approved",
      decision: { decidedById: asha._id, decidedByName: "Asha Accountant", decidedAt: new Date(), approvedAmountMinor: input.amountMinor, paymentMethod: "card", transactionId: `TXN-${d.id.slice(-6)}` },
      delivery: { state: "delivered", attempts: 1, deliveredAt: new Date() },
    },
  });
  const recorded = await recordCoursePayment((await TetraDepositModel.findById(d.id).lean())!);
  if (!recorded.ok) throw new Error(`not recorded: ${recorded.message}`);
  return (await TetraDepositModel.findById(d.id).lean<any>())!;
}
const refPayments = async (externalId: string) =>
  (await Invoice.find({ "payments.externalRef": `tetra:${externalId}` }).lean<any[]>()).flatMap((i) => i.payments.filter((p: any) => p.externalRef === `tetra:${externalId}`));

/* ── 1. Refused ────────────────────────────────────────────────────────── */
step("1. Refused, with a plain reason");
let r = await signedPost(ORG, RECHECK, { ...payload(new Types.ObjectId().toString()), recheck: recheckOf() });
check("one finance never had: 404", r.status === 404 && /doesn't have this request/.test(messageOf(r)), `${r.status} ${j(r.body)}`);

const deposit = await svc.intakeTetraDeposit(ORG, inboundTetraDepositSchema.parse({ ...payload(new Types.ObjectId().toString()), type: "DEPOSIT", coursePayment: undefined }));
await TetraDepositModel.updateOne({ _id: deposit.id }, { $set: { status: "approved", decision: { decidedByName: "Asha", decidedAt: new Date(), approvedAmountMinor: 61_308 }, delivery: { state: "delivered", attempts: 1 } } });
r = await signedPost(ORG, RECHECK, { ...payload(deposit.externalId, { type: "DEPOSIT", coursePayment: undefined }), recheck: recheckOf() });
check("a deposit, not a bonus: 409 \"Only a bonus…\"", r.status === 409 && /Only a bonus is rechecked/.test(messageOf(r)), `${r.status} ${j(r.body)}`);

const waiting = await svc.intakeTetraDeposit(ORG, inboundTetraDepositSchema.parse(payload(new Types.ObjectId().toString())));
r = await signedPost(ORG, RECHECK, { ...payload(waiting.externalId), recheck: recheckOf() });
check("one still waiting for a decision here: 409 \"already deciding it again\"", r.status === 409 && /already deciding it again/.test(messageOf(r)), `${r.status} ${j(r.body)}`);

await TetraDepositModel.updateOne({ _id: waiting.id }, { $set: { status: "rejected", decision: { decidedByName: "Asha", decidedAt: new Date(), reason: "No" } } });
r = await signedPost(ORG, RECHECK, { ...payload(waiting.externalId), recheck: recheckOf() });
check("a rejected one: 409 \"It is rejected in Delta Finance…\"", r.status === 409 && /It is rejected in Delta Finance/.test(messageOf(r)), `${r.status} ${j(r.body)}`);

const queued = await approvedBonus();
await TetraDepositModel.updateOne({ _id: queued._id }, { $set: { "delivery.state": "queued" } });
r = await signedPost(ORG, RECHECK, { ...payload(queued.externalId), recheck: recheckOf() });
check("its approval still on its way to CS Portal: 409, and its payment stays",
  r.status === 409 && /still sending its decision/.test(messageOf(r)) && (await refPayments(queued.externalId)).length === 1, `${r.status} ${j(r.body)}`);

r = await signedPost(ORG, RECHECK, payload(queued.externalId));
check("no `recheck` in the body: refused as malformed (4xx), nothing changed",
  r.status >= 400 && r.status < 500 && r.status !== 404 && (await TetraDepositModel.findById(queued._id).lean<any>())?.status === "approved", `${r.status} ${j(r.body)}`);

/* ── 2. The broker admin's recheck ─────────────────────────────────────── */
step("2. The broker admin sends an approved bonus back to recheck");
const a = await approvedBonus();
const invId = a.courseInvoice.invoiceId;
const paidBefore = (await Invoice.findById(invId).lean<any>())?.amountPaidMinor;
const receiptBefore = a.courseInvoice.receiptNumber;
const rk = recheckOf();
r = await signedPost(ORG, RECHECK, { ...payload(a.externalId), recheck: rk });
let row = await TetraDepositModel.findById(a._id).lean<any>();
let inv = await Invoice.findById(invId).lean<any>();
check("taken: 200, the request as it is now, pending", r.status === 200 && r.body?.data?.status === "pending" && r.body?.data?.recheck?.from === "broker_admin", `${r.status} ${j(r.body)}`);
check("…its payment is off the invoice: AED 2,250 less paid", (await refPayments(a.externalId)).length === 0 && inv?.amountPaidMinor === paidBefore - 225_000,
  j({ before: paidBefore, after: inv?.amountPaidMinor }));
check("…its approval, delivery and receipt are forgotten — a new approval records it again", !row?.decision && !row?.delivery && !row?.courseInvoice, j({ d: row?.decision, del: row?.delivery, ci: row?.courseInvoice }));
check("…who sent it back, what and why are kept, with the approval it replaces",
  row?.recheck?.key === rk.key && row?.recheck?.byName === "Raneesh Broker" && row?.recheck?.fields?.join(",") === "amount,receipt" && /4,500/.test(row?.recheck?.note ?? "")
  && row?.recheck?.previous?.amountMinor === 61_308 && row?.recheck?.previous?.decidedByName === "Asha Accountant" && row?.recheck?.previous?.receiptNumber === receiptBefore
  && Boolean(row?.recheck?.previous?.invoiceNumber) && row?.recheck?.previous?.transactionId === `TXN-${String(a._id).slice(-6)}`, j(row?.recheck));
const ev = row?.events?.at(-1);
check("…an event says so, and what came off", ev?.kind === "recheck" && /Sent back by Raneesh Broker \(broker admin, CS Portal\) to recheck: the amount, the receipt/.test(ev?.text ?? "")
  && /“Requested AED 2,250; the receipt shows 4,500”/.test(ev?.text ?? "") && /Approved before by Asha Accountant at USD 613\.08 — its payment AED 2,250\.00/.test(ev?.text ?? ""), j(ev));
const dto = svc.tetraDepositDTO(row);
check("…the DTO carries it for the page", dto.recheck?.from === "broker_admin" && dto.recheck?.previous?.amountMinor === 61_308 && dto.recheck?.fields.length === 2 && Boolean(dto.recheck?.at), j(dto.recheck));

const eventsN = row?.events?.length;
r = await signedPost(ORG, RECHECK, { ...payload(a.externalId), recheck: rk });
row = await TetraDepositModel.findById(a._id).lean<any>();
check("the same key again: 200, nothing changes", r.status === 200 && r.body?.data?.status === "pending" && row?.events?.length === eventsN, `${r.status} ${row?.events?.length}/${eventsN}`);
r = await signedPost(ORG, RECHECK, { ...payload(a.externalId), recheck: recheckOf() });
check("another key while it waits: 409 \"already deciding it again\"", r.status === 409 && /already deciding it again/.test(messageOf(r)), `${r.status} ${j(r.body)}`);
r = await signedPost(ORG, INTAKE, payload(a.externalId));
check("the intake sent again: the row as it is (pending, rechecked), no second row",
  r.status === 200 && r.body?.data?.id === String(a._id) && r.body?.data?.status === "pending" && (await TetraDepositModel.countDocuments({ externalId: a.externalId })) === 1, `${r.status} ${j(r.body)}`);
const page = await approvalList(auth as never, { status: "pending", type: "tetra_deposit", page: 1, pageSize: 100 } as never);
const onApprovals = page.rows.find((x) => x.id === String(a._id));
check("Approvals lists it waiting, and says why on the row", onApprovals?.status === "pending"
  && /Sent back by Raneesh Broker \(broker admin\) to recheck: the amount, the receipt — “Requested AED 2,250/.test(onApprovals?.flags?.[0] ?? ""), j(onApprovals));

/* ── 3. Approved again ─────────────────────────────────────────────────── */
step("3. The accountant approves it again, at the amount on the receipt");
const result = await svc.decideTetraDeposit(auth as never, String(a._id), { decision: "approved", amountMinor: 122_616, transactionId: "TXN-RECHECK-1", paymentMethod: "Card" } as never);
row = await TetraDepositModel.findById(a._id).lean<any>();
const again = await refPayments(a.externalId);
check("approved at USD 1,226.16, a new receipt", result.deposit.status === "approved" && row?.decision?.approvedAmountMinor === 122_616 && Boolean(row?.courseInvoice?.receiptNumber)
  && row?.courseInvoice?.receiptNumber !== receiptBefore, j({ s: result.deposit.status, d: row?.decision, ci: row?.courseInvoice }));
// An amount the accountant changed goes on in AED at × 3.67 (course-invoice.ts): USD 1,226.16 is AED 4,500.01.
check("…its payment is on the invoice once, at the new amount (AED 4,500, to the fil)", again.length === 1 && Math.abs(again[0].amountMinor - 450_000) <= 1, j(again.map((p: any) => p.amountMinor)));
check("…the recheck stays as its history", row?.recheck?.key === rk.key && row?.events?.some((e: any) => e.kind === "recheck"), j(row?.recheck));

/* ── 4. The CS's correction ────────────────────────────────────────────── */
step("4. Corrected by the CS after the broker admin sent it to them");
const b = await approvedBonus();
const corrected = payload(b.externalId, {
  amountMinor: 122_616, screenshotUrl: "https://files.e2e.test/receipt-2.png", coursePayment: cp({ paidTodayAed: 4500, balanceAed: 15500 }),
  payments: [{ method: "Card", amountMinor: 450_000, currency: "AED", receiptUrl: "https://files.e2e.test/receipt-2.png", receiptName: "receipt-2.png" }],
});
r = await signedPost(ORG, RECHECK, { ...corrected, recheck: recheckOf({ from: "cs", byName: "Cara CS", fields: ["amount", "receipt"], note: "The right receipt, AED 4,500" }) });
row = await TetraDepositModel.findById(b._id).lean<any>();
check("taken: pending, from the CS", r.status === 200 && row?.status === "pending" && row?.recheck?.from === "cs" && row?.recheck?.byName === "Cara CS", `${r.status} ${j(r.body)}`);
check("…the amount, the course payment and the receipt are the corrected ones",
  row?.amountMinor === 122_616 && row?.coursePayment?.paidTodayAed === 4500 && row?.screenshotUrl === "https://files.e2e.test/receipt-2.png"
  && row?.payments?.length === 1 && row?.payments?.[0]?.amountMinor === 450_000, j({ a: row?.amountMinor, cp: row?.coursePayment, s: row?.screenshotUrl, p: row?.payments }));
check("…the old payment is off the invoice", (await refPayments(b.externalId)).length === 0);
check("…the event says it was corrected, from what to what",
  /Corrected in CS Portal by Cara CS after the broker admin sent it back: the amount, the receipt — amount USD 613\.08 → USD 1,226\.16/.test(row?.events?.at(-1)?.text ?? ""), j(row?.events?.at(-1)));

/* ── 5. Reconciled ─────────────────────────────────────────────────────── */
step("5. A payment whose bank line was reconciled");
{
  const { BankAccount } = await import("../modules/banking/bank-account.model");
  const { BankTransaction } = await import("../modules/banking/bank-transaction.model");
  const d = await approvedBonus({}, { paidOn: "2026-11-17" });
  const acc = await BankAccount.create({ organizationId: org._id, accountName: "E2E Bank", accountType: "current", currency: "AED", openingDate: new Date("2026-01-01") } as any);
  const tx = await BankTransaction.create({ organizationId: org._id, accountId: acc._id, accountName: "E2E Bank", date: new Date("2026-11-17"), type: "credit", amountMinor: 225_000, description: "e2e", currency: "AED", runningBalanceMinor: 0, isReconciled: true } as any);
  await Invoice.updateOne({ _id: d.courseInvoice.invoiceId, "payments.externalRef": `tetra:${d.externalId}` }, { $set: { "payments.$.bankTransactionId": tx._id } });
  r = await signedPost(ORG, RECHECK, { ...payload(d.externalId), recheck: recheckOf() });
  const dRow = await TetraDepositModel.findById(d._id).lean<any>();
  check("not sent back: 409, saying the payment is reconciled", r.status === 409 && /Not sent back — its payment can't come off the invoice: .*reconciled/i.test(messageOf(r)), `${r.status} ${j(r.body)}`);
  check("…the request and its payment are as they were", dRow?.status === "approved" && !dRow?.recheck && (await refPayments(d.externalId)).length === 1, j({ s: dRow?.status, rc: dRow?.recheck }));
}

await mongoose.disconnect();
console.log(`\n${failures ? "\x1b[31m" : "\x1b[32m"}${checks - failures}/${checks} checks passed\x1b[0m`);
process.exit(failures ? 1 : 0);
