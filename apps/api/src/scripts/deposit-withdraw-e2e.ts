/**
 * A CS Portal course payment approved here, then not counted after all (the user, 2026-10-31: one AED 2,000
 * payment approved three times — two of them rejected in CS Portal — sat on its invoice three times):
 *
 *   1. CS Portal's withdrawal (POST /integrations/tetra-deposits/withdrawals, signed) takes the payment off its
 *      invoice — the balance with it — and keeps the request as deleted, saying who and why; again, nothing more.
 *   2. Never here, or being decided here again: answered, not refused (CS Portal tries again on a refusal).
 *   3. A reconciled bank line: kept, and said so.
 *   4. A reopen takes an approval's payment off; approved again, it goes back on once.
 *   5. The clean-up script: a payment left by a rejected request is listed, taken off with --write, put back by --undo.
 *
 * Run through scripts/deposit-withdraw-e2e.sh. Scratch databases only.
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
const { rejectedDepositPayments, undoRejectedDepositPayments } = await import("./rejected-deposit-payments");

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
const j = (v: unknown) => JSON.stringify(v).slice(0, 400);

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
const WITHDRAW = "/api/v1/integrations/tetra-deposits/withdrawals";

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();

const org = await Organization.create({ name: "Delta HQ E2E", baseCurrency: "AED" });
const ORG = String(org._id);
const asha = await User.create({ name: "Asha Accountant", email: "asha@e2e-withdraw.test", passwordHash: "x", status: "active", memberships: [{ organizationId: org._id, roleId: new Types.ObjectId(), status: "active" }] });
const auth = { userId: String(asha._id), organizationId: ORG, role: "accountant", permissions: ["tetra_deposit:approve"], isSuperAdmin: false };

const student = { id: new Types.ObjectId().toString(), code: "STU-9100", name: "Abel Student", email: "abel@e2e-withdraw.test", level: "1", phone: "+971500000000" };
const cp = (extra: Record<string, unknown> = {}) => ({ product: "DSLP Offer", kind: "partial", withBonus: true, bonusUsd: 500, price: 20000, priceCurrency: "AED", paidBeforeAed: 0, paidTodayAed: 2000, balanceAed: 18000, paidOn: "2026-10-13", ...extra });
/** A course payment as CS Portal hands it over, then approved here and put on its invoice — as decideTetraDeposit does, without the call back. */
async function approvedPayment(extra: Record<string, unknown> = {}) {
  const input = inboundTetraDepositSchema.parse({
    externalId: new Types.ObjectId().toString(), type: "BONUS", amountMinor: 54_496, currency: "USD", student, requestedBy: "Cara CS",
    paymentMethod: "Card", screenshotUrl: "https://files.e2e.test/r.png", coursePayment: cp(extra),
  });
  const d = await svc.intakeTetraDeposit(ORG, input);
  await TetraDepositModel.updateOne({ _id: d.id }, {
    $set: {
      status: "approved",
      decision: { decidedById: asha._id, decidedByName: "Asha Accountant", decidedAt: new Date(), approvedAmountMinor: 54_496, paymentMethod: "card", transactionId: "" },
      delivery: { state: "delivered", attempts: 1, deliveredAt: new Date() },
    },
  });
  const recorded = await recordCoursePayment((await TetraDepositModel.findById(d.id).lean())!);
  if (!recorded.ok) throw new Error(`not recorded: ${recorded.message}`);
  return (await TetraDepositModel.findById(d.id).lean<any>())!;
}
const invoiceOf = async (row: any) => Invoice.findById(row.courseInvoice.invoiceId).lean<any>();
const refsOn = (inv: any) => (inv?.payments ?? []).map((p: any) => p.externalRef);

/* ── 1. Withdrawn ──────────────────────────────────────────────────────── */
step("1. The same AED 2,000 approved three times; CS Portal rejects two");
const a = await approvedPayment(), b = await approvedPayment(), c = await approvedPayment();
let inv = await invoiceOf(a);
check("all three are on one invoice: AED 6,000 paid", String(inv?._id) === String(b.courseInvoice.invoiceId) && String(inv?._id) === String(c.courseInvoice.invoiceId)
  && inv?.payments?.length === 3 && inv?.amountPaidMinor === 600_000, j(inv && { n: inv.payments?.length, paid: inv.amountPaidMinor }));

let r = await signedPost(ORG, WITHDRAW, { externalId: a.externalId, byName: "Bo Broker", reason: "Repeat of the same payment" });
inv = await invoiceOf(a);
const aRow = await TetraDepositModel.findById(a._id).lean<any>();
check("CS Portal's withdrawal is taken: withdrawn, the payment named", r.status === 200 && r.body?.data?.outcome === "withdrawn" && /AED 2,000\.00 \(RCT-\d+\) off IN-/.test(r.body?.data?.message ?? ""), `${r.status} ${j(r.body)}`);
check("…its payment is off the invoice, the others stay: AED 4,000 paid, the balance up by 2,000",
  inv?.payments?.length === 2 && !refsOn(inv).includes(`tetra:${a.externalId}`) && inv?.amountPaidMinor === 400_000 && inv?.balanceMinor === (inv?.totalMinor ?? 0) - 400_000,
  j(inv && { n: inv.payments?.length, paid: inv.amountPaidMinor, bal: inv.balanceMinor, total: inv.totalMinor }));
check("…the request is kept as deleted, with who and why, and what it was",
  aRow?.status === "deleted" && aRow?.deleted?.previousStatus === "approved" && /Rejected in CS Portal by Bo Broker \(CS Portal\): Repeat/.test(aRow?.deleted?.reason ?? "")
  && aRow?.withdrawal?.state === "done" && aRow?.events?.some((e: any) => e.kind === "withdrawn"), j(aRow && { s: aRow.status, d: aRow.deleted, w: aRow.withdrawal }));

r = await signedPost(ORG, WITHDRAW, { externalId: a.externalId, byName: "Bo Broker", reason: "again" });
inv = await invoiceOf(a);
check("sent again: \"already\", and nothing else comes off", r.status === 200 && r.body?.data?.outcome === "already" && inv?.payments?.length === 2, `${r.status} ${j(r.body)}`);

r = await signedPost(ORG, WITHDRAW, { externalId: b.externalId, byName: "Bo Broker", reason: "Repeat" });
inv = await invoiceOf(a);
check("the second repeat: off too — one AED 2,000 left, the one CS Portal approved", r.body?.data?.outcome === "withdrawn" && inv?.payments?.length === 1
  && refsOn(inv)[0] === `tetra:${c.externalId}` && inv?.amountPaidMinor === 200_000, j(inv && { refs: refsOn(inv), paid: inv.amountPaidMinor }));

/* ── 2. Answered, not refused ──────────────────────────────────────────── */
step("2. Never here, or being decided here again");
r = await signedPost(ORG, WITHDRAW, { externalId: new Types.ObjectId().toString(), byName: "x" });
check("one finance never had: \"unknown\" (200, so CS Portal stops)", r.status === 200 && r.body?.data?.outcome === "unknown", `${r.status} ${j(r.body)}`);
const pendingInput = inboundTetraDepositSchema.parse({
  externalId: new Types.ObjectId().toString(), type: "BONUS", amountMinor: 54_496, currency: "USD", student, requestedBy: "Cara CS",
  paymentMethod: "Card", screenshotUrl: "https://files.e2e.test/r.png", coursePayment: cp(),
});
const pending = await svc.intakeTetraDeposit(ORG, pendingInput);
r = await signedPost(ORG, WITHDRAW, { externalId: pending.externalId, byName: "x" });
check("one waiting for a decision here: \"pending\" — tried later, nothing changed",
  r.status === 200 && r.body?.data?.outcome === "pending" && (await TetraDepositModel.findById(pending.id).lean<any>())?.status === "pending", `${r.status} ${j(r.body)}`);
r = await signedPost(ORG, WITHDRAW, { externalId: "not-an-id" });
check("a malformed id is refused (422 — CS Portal takes it as final)", r.status === 422, `${r.status} ${j(r.body)}`);
r = await signedPost(new Types.ObjectId().toString(), WITHDRAW, { externalId: c.externalId });
check("another organization's header finds nothing of this one's", r.status === 404 && (await invoiceOf(c))?.payments?.length === 1, `${r.status} ${j(r.body)}`);

/* ── 3. Reconciled ─────────────────────────────────────────────────────── */
step("3. A payment whose bank line was reconciled");
{
  const { BankAccount } = await import("../modules/banking/bank-account.model");
  const { BankTransaction } = await import("../modules/banking/bank-transaction.model");
  const d = await approvedPayment({ paidOn: "2026-10-14" });
  const acc = await BankAccount.create({ organizationId: org._id, accountName: "E2E Bank", accountType: "current", currency: "AED", openingDate: new Date("2026-01-01") } as any);
  const tx = await BankTransaction.create({ organizationId: org._id, accountId: acc._id, accountName: "E2E Bank", date: new Date("2026-10-14"), type: "credit", amountMinor: 200_000, description: "e2e", currency: "AED", runningBalanceMinor: 0, isReconciled: true } as any);
  await Invoice.updateOne({ _id: d.courseInvoice.invoiceId, "payments.externalRef": `tetra:${d.externalId}` }, { $set: { "payments.$.bankTransactionId": tx._id } });
  const before = (await invoiceOf(d))?.payments?.length;
  r = await signedPost(ORG, WITHDRAW, { externalId: d.externalId, byName: "Bo Broker", reason: "Repeat" });
  const row = await TetraDepositModel.findById(d._id).lean<any>();
  check("kept, and said why: reconciled", r.status === 200 && r.body?.data?.outcome === "kept" && /reconciled/.test(r.body?.data?.message ?? ""), `${r.status} ${j(r.body)}`);
  check("…the payment stays and the request is as it was, marked for an accountant",
    (await invoiceOf(d))?.payments?.length === before && row?.status === "approved" && row?.withdrawal?.state === "kept" && row?.events?.some((e: any) => e.kind === "withdrawal_kept"), j(row && { s: row.status, w: row.withdrawal }));
  // Out of the way for what follows.
  await Invoice.updateOne({ _id: d.courseInvoice.invoiceId, "payments.externalRef": `tetra:${d.externalId}` }, { $unset: { "payments.$.bankTransactionId": "" } });
  await svc.takeOffRecordedPayments(row);
}

/* ── 4. Reopened ───────────────────────────────────────────────────────── */
step("4. Reopened in finance (a decision CS Portal turned down)");
{
  const d = await approvedPayment({ paidOn: "2026-10-15" });
  await TetraDepositModel.updateOne({ _id: d._id }, { $set: { "delivery.state": "failed", "delivery.lastError": "e2e" } });
  const invId = d.courseInvoice.invoiceId;
  const before = (await Invoice.findById(invId).lean<any>())?.amountPaidMinor;
  await svc.reopenTetraDeposit(auth as never, String(d._id));
  const row = await TetraDepositModel.findById(d._id).lean<any>();
  const after = await Invoice.findById(invId).lean<any>();
  check("reopened, its payment comes off the invoice", row?.status === "pending" && !refsOn(after).includes(`tetra:${d.externalId}`) && after?.amountPaidMinor === before - 200_000,
    j({ s: row?.status, refs: refsOn(after), paid: [before, after?.amountPaidMinor] }));
  check("…and it forgets the invoice it went on, so a new approval records it", !row?.courseInvoice && /its payment AED 2,000\.00/.test(row?.events?.at(-1)?.text ?? ""), j(row?.events?.at(-1)));
  await TetraDepositModel.updateOne({ _id: d._id }, { $set: { status: "approved", decision: { decidedById: asha._id, decidedByName: "Asha Accountant", decidedAt: new Date(), approvedAmountMinor: 54_496, paymentMethod: "card" } } });
  const again = await recordCoursePayment((await TetraDepositModel.findById(d._id).lean())!);
  await recordCoursePayment((await TetraDepositModel.findById(d._id).lean())!);
  const back = await TetraDepositModel.findById(d._id).lean<any>();
  const onInvoice = (await Invoice.find({ "payments.externalRef": `tetra:${d.externalId}` }).lean<any[]>()).flatMap((i) => i.payments.filter((p: any) => p.externalRef === `tetra:${d.externalId}`));
  check("approved again: back on, once", again.ok && onInvoice.length === 1 && Boolean(back?.courseInvoice?.receiptNumber), j({ again, n: onInvoice.length }));

  // Reconciled: the reopen is refused, nothing changed.
  const e = await approvedPayment({ paidOn: "2026-10-16" });
  const { BankAccount } = await import("../modules/banking/bank-account.model");
  const { BankTransaction } = await import("../modules/banking/bank-transaction.model");
  const acc = await BankAccount.findOne({ organizationId: org._id }).lean<any>();
  const tx = await BankTransaction.create({ organizationId: org._id, accountId: acc._id, accountName: "E2E Bank", date: new Date("2026-10-16"), type: "credit", amountMinor: 200_000, description: "e2e", currency: "AED", runningBalanceMinor: 0, isReconciled: true } as any);
  await Invoice.updateOne({ _id: e.courseInvoice.invoiceId, "payments.externalRef": `tetra:${e.externalId}` }, { $set: { "payments.$.bankTransactionId": tx._id } });
  await TetraDepositModel.updateOne({ _id: e._id }, { $set: { "delivery.state": "failed" } });
  let refused = "";
  try { await svc.reopenTetraDeposit(auth as never, String(e._id)); } catch (err) { refused = (err as Error).message; }
  const eRow = await TetraDepositModel.findById(e._id).lean<any>();
  check("a reconciled one isn't reopened, and keeps its payment", /Not reopened.*reconciled/.test(refused) && eRow?.status === "approved"
    && (await Invoice.countDocuments({ "payments.externalRef": `tetra:${e.externalId}` })) === 1, refused);
  await Invoice.updateOne({ _id: e.courseInvoice.invoiceId, "payments.externalRef": `tetra:${e.externalId}` }, { $unset: { "payments.$.bankTransactionId": "" } });
  await svc.takeOffRecordedPayments(eRow);
  await TetraDepositModel.updateOne({ _id: e._id }, { $set: { status: "deleted", deleted: { at: new Date(), byName: "e2e", reason: "e2e", previousStatus: "approved" } } });
}

/* ── 5. The clean-up script ────────────────────────────────────────────── */
step("5. The clean-up: a payment left by a request finance rejected (approved, reopened, rejected — before the fix)");
{
  const d = await approvedPayment({ paidOn: "2026-10-17" });
  // As before 2026-10-31: rejected after a reopen, its payment left on the invoice.
  await TetraDepositModel.updateOne({ _id: d._id }, { $set: { status: "rejected", decision: { decidedById: asha._id, decidedByName: "Asha Accountant", decidedAt: new Date(), reason: "e2e" } } });
  const receipt = (await invoiceOf(d))?.payments?.find((p: any) => p.externalRef === `tetra:${d.externalId}`)?.receiptNumber;
  const dry = await rejectedDepositPayments({ write: false });
  check("the dry run lists it, and only it — the approved one isn't touched", dry.rows.length === 1 && dry.rows[0]!.externalId === d.externalId && dry.rows[0]!.outcome === "would take off"
    && (await Invoice.countDocuments({ "payments.externalRef": `tetra:${d.externalId}` })) === 1, j(dry.rows));
  let wrong = "";
  try { await rejectedDepositPayments({ write: true, expect: 5 }); } catch (err) { wrong = (err as Error).message; }
  check("--expect that doesn't match writes nothing", /Expected 5/.test(wrong) && (await Invoice.countDocuments({ "payments.externalRef": `tetra:${d.externalId}` })) === 1, wrong);
  const cwd = process.cwd();
  process.chdir((await import("node:os")).tmpdir());
  const done = await rejectedDepositPayments({ write: true, expect: 1 });
  const left = await invoiceOf(d);
  check("--write takes it off, saves an undo file, and notes it on the request",
    done.rows[0]?.outcome === "taken off" && Boolean(done.undoFile) && !refsOn(left).includes(`tetra:${d.externalId}`)
    && (await TetraDepositModel.findById(d._id).lean<any>())?.events?.some((e: any) => e.kind === "payment_removed"), j(done));
  check("…the one CS Portal approved (c) is still on its invoice", (await Invoice.countDocuments({ "payments.externalRef": `tetra:${c.externalId}` })) === 1);
  const again = await rejectedDepositPayments({ write: false });
  check("run again: nothing left", again.rows.length === 0, j(again.rows));
  const back = await undoRejectedDepositPayments(done.undoFile!);
  const restored = (await invoiceOf(d))?.payments?.find((p: any) => p.externalRef === `tetra:${d.externalId}`);
  check("--undo records it again, with its receipt number", back === 1 && restored?.receiptNumber === receipt && restored?.amountMinor === 200_000, j({ back, restored: restored && { r: restored.receiptNumber, a: restored.amountMinor }, receipt }));
  (await import("node:fs")).rmSync(done.undoFile!, { force: true });
  process.chdir(cwd);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
