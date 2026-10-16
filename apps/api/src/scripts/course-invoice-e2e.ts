/**
 * Course payments from Tetra Commission become invoices with receipts (the
 * user, 2026-10-12) — finance's services in this process, a real Tetra
 * Commission taking the decisions:
 *
 *   1. An upgrade's first approved payment makes its invoice — the upgrade's
 *      price, AED, issued on the day paid — and records the payment with a
 *      receipt number; the next goes on the same invoice; more than is left is
 *      refused and stays pending. A new upgrade (a course change) is a new invoice.
 *   2. A bonus's course payment (USD; the AED paid at 3.67) makes an invoice for
 *      what was paid plus the balance, and the next for the course goes on it;
 *      an amount the accountant changed is converted at 3.67.
 *   3. The student's sales-CRM enrolment for the same course, with a balance,
 *      takes it; a bundle ("MBT + DWT") never does.
 *   4. A bonus with no course money makes no invoice; a student with no email
 *      is refused and stays pending.
 *   5. Tetra Commission keeps the invoice and receipt on the payment or bonus.
 *   6. Recorded once, however often it is retried.
 *   7. The backfill: an old approved one is listed, recorded, sent again —
 *      Tetra Commission keeps the invoice from the repeat — and one with an
 *      invoice typed by hand since is left alone.
 *
 * Run through scripts/course-invoice-e2e.sh. Scratch databases only.
 */
import mongoose, { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
const commissionUri = process.env.COMMISSION_MONGO_URI ?? "";
const commissionDb = process.env.COMMISSION_MONGO_DB ?? "";
for (const [name, value] of [["MONGODB_URI", uri], ["COMMISSION_MONGO_URI", `${commissionUri}/${commissionDb}`]]) {
  if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(value!) || !/e2e/i.test(value!)) {
    console.error(`Refusing to run: ${name} must be a scratch e2e database on 127.0.0.1, got "${value}"`);
    process.exit(1);
  }
}

const { inboundTetraDepositSchema } = await import("@delta/shared");
const { Organization } = await import("../modules/organization/organization.model");
const { User } = await import("../modules/user/user.model");
const { Invoice } = await import("../modules/invoice/invoice.model");
const { Customer } = await import("../modules/customer/customer.model");
const { TetraDepositModel } = await import("../modules/tetra-deposit/tetra-deposit.model");
const svc = await import("../modules/tetra-deposit/tetra-deposit.service");
const { createInvoice } = await import("../modules/invoice/invoice.service");
const { findOrCreateCustomer } = await import("../modules/customer/customer.service");
const { backfillCourseInvoices } = await import("./course-invoice-backfill");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const j = (v: unknown) => JSON.stringify(v).slice(0, 400);

await mongoose.connect(uri);
const tc = await mongoose.createConnection(commissionUri, { dbName: commissionDb }).asPromise();
if (mongoose.connection.host !== "127.0.0.1" || tc.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();
for (const c of await tc.db!.listCollections().toArray()) await tc.db!.collection(c.name).deleteMany({});
const tcPayments = tc.db!.collection("course_payments");
const tcTxs = tc.db!.collection("funding_transactions");

const org = await Organization.create({ name: "Delta HQ E2E", baseCurrency: "AED" });
const ORG = String(org._id);
const asha = await User.create({ name: "Asha Accountant", email: "asha@e2e-course.test", passwordHash: "x", status: "active", memberships: [{ organizationId: org._id, roleId: new Types.ObjectId(), status: "active" }] });
const auth = { userId: String(asha._id), organizationId: ORG, role: "accountant", permissions: ["tetra_deposit:approve"], isSuperAdmin: false };

let n = 0;
const student = (code: string, email = `${code.toLowerCase()}@e2e-course.test`) => ({ id: new Types.ObjectId().toString(), code, name: `Student ${code}`, email, level: "1", phone: "+971500000000" });
/** A request as Tetra Commission sends it, received here; its twin in Tetra Commission so the decision lands. */
async function arrive(over: Record<string, unknown>) {
  const externalId = new Types.ObjectId();
  const input = inboundTetraDepositSchema.parse({ externalId: String(externalId), requestedBy: "Cara CS", paymentMethod: "Card", screenshotUrl: "https://files.e2e.test/r.png", ...over });
  if (input.type === "COURSE_UPGRADE") {
    await tcPayments.insertOne({ _id: externalId, upgrade_id: String(input.coursePayment?.upgradeId ?? ""), student_id: input.student.id, amount_aed: input.amountMinor / 100, status: "pending", finance_approval: { state: "sent" }, recorded_at: new Date().toISOString() });
  } else {
    await tcTxs.insertOne({ _id: externalId, type: "BONUS", status: "PENDING", student_id: input.student.id, student_name: input.student.name, amount_usd: input.amountMinor / 100, finance_approval: { state: "sent" }, course_payment: { product: input.coursePayment?.product } });
  }
  return svc.intakeTetraDeposit(ORG, input);
}
const approve = (id: string, amountMinor: number, tx = `TX-${++n}`) => svc.decideTetraDeposit(auth as never, id, { decision: "approved", amountMinor, transactionId: tx, paymentMethod: "", mt5Login: "", note: "" } as never);
const tryApprove = async (id: string, amountMinor: number) => { try { return { ok: true, r: await approve(id, amountMinor) } as const; } catch (e) { return { ok: false, message: (e as Error).message } as const; } };
const row = (id: string) => TetraDepositModel.findById(id).lean<any>();
const invoiceOf = async (id: string) => { const r = await row(id); return r?.courseInvoice?.invoiceId ? Invoice.findById(r.courseInvoice.invoiceId).lean<any>() : null; };
const upgradeCp = (upgradeId: string, price: number, extra: Record<string, unknown> = {}) => ({ product: "DSLP Offer", kind: "partial", withBonus: true, bonusUsd: 500, price, priceCurrency: "AED", upgradeId, paidOn: "2026-10-10", ...extra });

/* ── 1. An upgrade ─────────────────────────────────────────────────────── */
step("1. A course upgrade's payments: one invoice, a receipt each");
const s1 = student("STU-1");
const up1 = new Types.ObjectId().toString();
const p1 = await arrive({ type: "COURSE_UPGRADE", amountMinor: 500_000, currency: "AED", student: s1, coursePayment: upgradeCp(up1, 20_000, { paidTodayAed: 5000, balanceAed: 15000 }) });
const a1 = await approve(p1.id, 500_000);
const i1 = await invoiceOf(p1.id);
check("the first payment makes the invoice: the upgrade's AED 20,000, issued the day it was paid",
  i1?.totalMinor === 2_000_000 && i1?.currency === "AED" && i1?.issueDate?.toISOString().slice(0, 10) === "2026-10-10" && i1?.external?.source === "tetra-course", j(i1 && { t: i1.totalMinor, c: i1.currency, d: i1.issueDate, e: i1.external }));
check("…for the student as the client, found by email (made, with the phone Tetra Commission sent)",
  String(i1?.customerId) === String((await Customer.findOne({ email: s1.email }).lean<any>())?._id) && (await Customer.findOne({ email: s1.email }).lean<any>())?.phone === "+971500000000");
check("…needs no approval of its own, and the payment is on it: AED 5,000 paid, 15,000 left, part paid",
  i1?.approval?.state === "not_required" && i1?.amountPaidMinor === 500_000 && i1?.balanceMinor === 1_500_000 && i1?.status === "partial", j(i1 && { a: i1.approval, p: i1.amountPaidMinor, b: i1.balanceMinor, s: i1.status }));
const pay1 = i1?.payments?.[0];
check("…with a receipt number, the day paid, the method and the transaction ID", pay1?.receiptNumber === "RCT-00001" && pay1?.paidOn?.toISOString().slice(0, 10) === "2026-10-10" && pay1?.method === "card" && pay1?.reference === "TX-1", j(pay1));
check("the accountant is told: invoice made, receipt emailed", /invoice made IN-\d+, receipt RCT-00001/.test(a1.message ?? ""), a1.message);
const tp1 = await tcPayments.findOne({ _id: new Types.ObjectId(p1.externalId) });
check("Tetra Commission keeps the invoice and receipt on the payment", tp1?.status === "approved" && tp1?.course_invoice?.invoice_number === i1?.invoiceNumber
  && tp1?.course_invoice?.receipt_number === "RCT-00001" && tp1?.course_invoice?.balance_minor === 1_500_000, j(tp1?.course_invoice));

const { EmailLog } = await import("../modules/email-log/email-log.model");
let mail: any = null;
for (let k = 0; k < 40 && !mail; k++) { mail = await EmailLog.findOne({ kind: "course_payment_receipt", to: s1.email }).lean(); if (!mail) await Bun.sleep(100); }
check("the client is emailed the receipt (logged, once)", /^Payment receipt RCT-00001/.test(String(mail?.subject ?? "")) && Boolean((await row(p1.id))?.courseInvoice?.emailedAt), j(mail));
{
  // Sent again (scripts/resend-course-receipts.ts — 2026-10-16, RCT-00001/2 cut off by the move script).
  const { resendCourseReceipt } = await import("../modules/tetra-deposit/course-invoice");
  const tries = () => EmailLog.countDocuments({ kind: "course_payment_receipt", to: s1.email, subject: /RCT-00001/ });
  const before = await tries();
  const again = await resendCourseReceipt(p1.id);
  check("a receipt whose email did not go is tried again, and says how it went", /^not sent: not_configured/.test(again) && (await tries()) === before + 1, `${again} · ${before} → ${await tries()}`);
  await EmailLog.updateMany({ kind: "course_payment_receipt", to: s1.email }, { $set: { state: "sent" } });
  const skipped = await resendCourseReceipt(p1.id);
  check("…one the log shows went is not sent twice", /^already sent \(RCT-00001\)/.test(skipped) && (await tries()) === before + 1, skipped);
  const forced = await resendCourseReceipt(p1.id, { force: true });
  check("…unless forced", /^not sent/.test(forced) && (await tries()) === before + 2, forced);
}

const p2 = await arrive({ type: "COURSE_UPGRADE", amountMinor: 1_500_000, currency: "AED", student: s1, coursePayment: upgradeCp(up1, 20_000, { paidTodayAed: 15000, balanceAed: 0, paidOn: "2026-10-11" }) });
await approve(p2.id, 1_500_000);
const i2 = await invoiceOf(p2.id);
check("the next payment goes on the same invoice — paid in full, receipt RCT-00002", String(i2?._id) === String(i1?._id) && i2?.status === "paid" && i2?.balanceMinor === 0 && i2?.payments?.[1]?.receiptNumber === "RCT-00002", j(i2 && { s: i2.status, b: i2.balanceMinor }));
check("…and still one invoice for the upgrade", (await Invoice.countDocuments({ "external.externalId": `upgrade:${up1}` })) === 1);

const p3 = await arrive({ type: "COURSE_UPGRADE", amountMinor: 10_000, currency: "AED", student: s1, coursePayment: upgradeCp(up1, 20_000, { paidTodayAed: 100 }) });
const r3 = await tryApprove(p3.id, 10_000);
check("more than is left is refused, in front of the accountant, and stays pending", !r3.ok && /already fully paid/i.test(r3.ok ? "" : r3.message) && (await row(p3.id))?.status === "pending", j(r3));
check("…and Tetra Commission was not told it was approved", (await tcPayments.findOne({ _id: new Types.ObjectId(p3.externalId) }))?.status === "pending");

const up2 = new Types.ObjectId().toString();
const p4 = await arrive({ type: "COURSE_UPGRADE", amountMinor: 1_000_000, currency: "AED", student: s1, coursePayment: upgradeCp(up2, 48_000, { product: "DQMP" }) });
await approve(p4.id, 1_000_000);
const i4 = await invoiceOf(p4.id);
check("a new upgrade (a course change) is a new invoice, for its own price", i4 && String(i4._id) !== String(i1?._id) && i4.totalMinor === 4_800_000 && i4.balanceMinor === 3_800_000, j(i4 && { t: i4.totalMinor, b: i4.balanceMinor }));

/* ── 2. A bonus's course payment ───────────────────────────────────────── */
step("2. A bonus's course payment (USD; AED paid at 3.67)");
const s2 = student("STU-2");
const bonusCp = (extra: Record<string, unknown>) => ({ product: "DSLP", kind: "partial", withBonus: true, bonusUsd: 500, price: 18370, priceCurrency: "AED", paidBeforeAed: 0, ...extra });
const b1 = await arrive({ type: "BONUS", amountMinor: 54_496, currency: "USD", student: s2, coursePayment: bonusCp({ paidTodayAed: 2000, balanceAed: 18000, paidOn: "2026-10-07" }) });
const ab1 = await approve(b1.id, 54_496);
const ib1 = await invoiceOf(b1.id);
check("it makes an invoice for what was paid plus the balance: AED 20,000, 2,000 paid", ib1?.totalMinor === 2_000_000 && ib1?.amountPaidMinor === 200_000 && ib1?.payments?.[0]?.receiptNumber === "RCT-00004", j(ib1 && { t: ib1.totalMinor, p: ib1.amountPaidMinor, r: ib1.payments?.[0]?.receiptNumber }));
check("…the payment notes the dollars asked", /\$544\.96|USD 544\.96/.test(ib1?.payments?.[0]?.notes ?? ""), ib1?.payments?.[0]?.notes);
const tb1 = await tcTxs.findOne({ _id: new Types.ObjectId(b1.externalId) });
check("Tetra Commission keeps the invoice on the bonus — which waits for a broker admin as before", tb1?.status === "PENDING" && tb1?.finance_approval?.decision === "approved" && tb1?.course_invoice?.invoice_number === ib1?.invoiceNumber, j({ s: tb1?.status, ci: tb1?.course_invoice }));
check("the accountant is told about the invoice", /invoice made IN-/.test(ab1.message ?? ""), ab1.message);

const b2 = await arrive({ type: "BONUS", amountMinor: 100_000, currency: "USD", student: s2, coursePayment: bonusCp({ paidTodayAed: 3670, balanceAed: 14330, paidBeforeAed: 2000 }) });
await approve(b2.id, 100_000);
const ib2 = await invoiceOf(b2.id);
check("the next payment for the course goes on the same invoice: 5,670 paid, 14,330 left", String(ib2?._id) === String(ib1?._id) && ib2?.amountPaidMinor === 567_000 && ib2?.balanceMinor === 1_433_000, j(ib2 && { p: ib2.amountPaidMinor, b: ib2.balanceMinor }));
const b3 = await arrive({ type: "BONUS", amountMinor: 54_496, currency: "USD", student: s2, coursePayment: bonusCp({ paidTodayAed: 2000, balanceAed: 12330 }) });
await approve(b3.id, 50_000);
const ib3 = await invoiceOf(b3.id);
check("an amount the accountant changed ($500, not $544.96) is recorded at 3.67: AED 1,835", ib3?.payments?.at(-1)?.amountMinor === 183_500, j(ib3?.payments?.at(-1)));

/* ── 3. The sales CRM's invoice for the course ─────────────────────────── */
step("3. The student's sales-CRM enrolment for the same course");
const s3 = student("STU-3");
const { customer: c3 } = await findOrCreateCustomer(ORG, { name: s3.name, email: s3.email, phone: "+97150" } as never);
const crmInvoice = async (course: string, total: number) => {
  const inv = await createInvoice(ORG, { customerId: c3.id, salespersonId: String(asha._id), issueDate: "2026-10-01", dueDate: "2026-10-01", currency: "AED", taxInclusive: true, lineItems: [{ description: course, quantity: 1, unitPriceMinor: total, taxes: [] }] } as never, { all: true });
  await Invoice.updateOne({ _id: inv.id }, { $set: { external: { source: "crm", externalId: `crm-${course}` }, "approval.state": "approved", enrolment: { course, modeOfStudy: "online", language: "English", meetingBy: "Sam Sales" }, status: "sent" } });
  return inv;
};
const bundle = await crmInvoice("COURSE 2 - MBT + DWT (WITH CREDIT)", 550_000);
const dwt = await crmInvoice("Delta Wave Theory", 325_000);
const b4 = await arrive({ type: "BONUS", amountMinor: 27_248, currency: "USD", student: s3, coursePayment: { product: "DWT", kind: "partial", withBonus: true, bonusUsd: 500, paidTodayAed: 1000, balanceAed: 2250 } });
const ab4 = await approve(b4.id, 27_248);
const after4 = await row(b4.id);
check("it goes on the CRM's Delta Wave Theory invoice — no new one", String(after4?.courseInvoice?.invoiceId) === dwt.id && after4?.courseInvoice?.created === false, j(after4?.courseInvoice));
check("…the bundle (MBT + DWT) is left alone", (await Invoice.findById(bundle.id).lean<any>())?.amountPaidMinor === 0);
check("…the accountant is told it was recorded on that invoice", ab4.message?.includes(`recorded on invoice ${dwt.invoiceNumber}`) ?? false, ab4.message);
const b5 = await arrive({ type: "BONUS", amountMinor: 54_496, currency: "USD", student: s3, coursePayment: { product: "MBT", kind: "partial", withBonus: true, paidTodayAed: 2000, balanceAed: 250 } });
await approve(b5.id, 54_496);
check("MBT for the same student: the bundle is not taken — a new invoice", (await row(b5.id))?.courseInvoice?.created === true && (await Invoice.findById(bundle.id).lean<any>())?.amountPaidMinor === 0);

/* ── 4. No course money, no email ──────────────────────────────────────── */
step("4. A bonus with no course money, and a student with no email");
const b6 = await arrive({ type: "BONUS", amountMinor: 10_000, currency: "USD", student: student("STU-6") });
await approve(b6.id, 10_000);
check("a bonus with no course payment makes no invoice, approved as before", (await row(b6.id))?.status === "approved" && !(await row(b6.id))?.courseInvoice);
const b7 = await arrive({ type: "BONUS", amountMinor: 54_496, currency: "USD", student: student("STU-7", ""), coursePayment: bonusCp({ paidTodayAed: 2000, balanceAed: 18000 }) });
const r7 = await tryApprove(b7.id, 54_496);
check("no email: refused with why, still pending", !r7.ok && /no email/i.test(r7.ok ? "" : r7.message) && (await row(b7.id))?.status === "pending", j(r7));

/* ── 6. Once ───────────────────────────────────────────────────────────── */
step("6. Recorded once, however often it is retried");
const { recordCoursePayment } = await import("../modules/tetra-deposit/course-invoice");
await recordCoursePayment(await row(p1.id));
await recordCoursePayment({ ...(await row(b1.id)), courseInvoice: undefined });
const again1 = await Invoice.findById(i1?._id).lean<any>();
const againB = await Invoice.findById(ib1?._id).lean<any>();
check("the upgrade's invoice still has its two payments", again1?.payments?.length === 2 && again1?.amountPaidMinor === 2_000_000);
check("a retry that lost its memory finds the payment by its reference, not twice", againB?.payments?.length === 3 && againB?.amountPaidMinor === 567_000 + 183_500, j(againB && { n: againB.payments.length, p: againB.amountPaidMinor }));

/* ── 7. The backfill ───────────────────────────────────────────────────── */
step("7. The backfill: the ones approved before");
const old = async (code: string, extra: Record<string, unknown> = {}) => {
  const s = student(code);
  const d = await arrive({ type: "BONUS", amountMinor: 54_496, currency: "USD", student: s, coursePayment: bonusCp({ paidTodayAed: 2000, balanceAed: 18000 }), ...extra });
  // Approved before this existed: decided and delivered, no invoice.
  await TetraDepositModel.updateOne({ _id: d.id }, { $set: { status: "approved", decision: { decidedById: asha._id, decidedByName: "Asha", decidedAt: new Date(), approvedAmountMinor: 54_496, transactionId: `OLD-${code}` }, delivery: { state: "delivered", attempts: 1 } } });
  await tcTxs.updateOne({ _id: new Types.ObjectId(d.externalId) }, { $set: { finance_approval: { state: "decided", decision: "approved" }, transaction_id: `OLD-${code}` } });
  return { d, s };
};
const o1 = await old("STU-8");
const o2 = await old("STU-9");
// STU-9 had an invoice typed by hand since — maybe this payment, invoiced already.
const { customer: c9 } = await findOrCreateCustomer(ORG, { name: o2.s.name, email: o2.s.email, phone: "+97150" } as never);
await createInvoice(ORG, { customerId: c9.id, salespersonId: String(asha._id), issueDate: "2026-10-08", dueDate: "2026-10-08", currency: "AED", lineItems: [{ description: "DSLP", quantity: 1, unitPriceMinor: 200_000, taxes: [] }] } as never, { all: true });
const invoicesBefore = await Invoice.countDocuments({});
const o3 = await old("STU-TEST");
const skipped = await backfillCourseInvoices({ write: true, skip: ["stu-test", "nobody"] });
check("--skip leaves a named student's out (by code, any case)", skipped.find((r) => r.id === o3.d.id)?.outcome === "skipped (--skip)" && !(await row(o3.d.id))?.courseInvoice
  && skipped.filter((r) => r.outcome.startsWith("recorded")).length === 1, j(skipped));
// Put back to how it was before that run, for the checks below.
await TetraDepositModel.updateOne({ _id: o1.d.id }, { $unset: { courseInvoice: "" }, $set: { "delivery.state": "delivered" } });
await Invoice.deleteMany({ "external.externalId": { $regex: `^course:${o1.s.id}:` } });
await TetraDepositModel.deleteOne({ _id: o3.d.id });
const dry = await backfillCourseInvoices({ write: false });
check("the dry run lists both, changes nothing", dry.length === 2 && (await Invoice.countDocuments({})) === invoicesBefore && !(await row(o1.d.id))?.courseInvoice, j(dry));
check("…the one typed by hand is shown and left alone", /left alone — typed by hand/.test(dry.find((r) => r.id === o2.d.id)?.outcome ?? ""), j(dry.find((r) => r.id === o2.d.id)));
const wrote = await backfillCourseInvoices({ write: true });
const ro1 = await row(o1.d.id);
check("--write records the other: invoice made, receipt, queued to send again", ro1?.courseInvoice?.receiptNumber?.startsWith("RCT-") && ro1?.delivery?.state === "queued" && !ro1?.courseInvoice?.emailedAt, j({ ci: ro1?.courseInvoice, del: ro1?.delivery }));
check("…the hand-typed one still left alone", !(await row(o2.d.id))?.courseInvoice && /left alone/.test(wrote.find((r) => r.id === o2.d.id)?.outcome ?? ""));
await svc.drainTetraDepositDecisions();
const to1 = await tcTxs.findOne({ _id: new Types.ObjectId(o1.d.externalId) });
check("sent again, Tetra Commission keeps the invoice from the repeat (and changes nothing else)", to1?.course_invoice?.invoice_number === ro1?.courseInvoice?.invoiceNumber && to1?.status === "PENDING" && (await row(o1.d.id))?.delivery?.state === "delivered", j({ ci: to1?.course_invoice, s: to1?.status, del: (await row(o1.d.id))?.delivery }));
const again = await backfillCourseInvoices({ write: true });
check("run again: nothing more to do (the hand-typed one is still listed)", again.length === 1 && again[0]!.id === o2.d.id);
await backfillCourseInvoices({ write: true, include: [o2.d.id] });
check("--include does the hand-typed one when asked", Boolean((await row(o2.d.id))?.courseInvoice?.receiptNumber));

/* ── 8. Send back (the user, 2026-10-13) ───────────────────────────────── */
step("8. Send back: a bonus back to its CS to correct, and sent again");
{
  const sb = await arrive({ type: "BONUS", amountMinor: 30_000, currency: "USD", student: student("STU-SB") });
  const why = "The receipt is for another amount — attach the right one";
  const sent = await svc.decideTetraDeposit(auth as never, sb.id, { decision: "rejected", reason: why, sentBack: true } as never);
  const row1 = await row(sb.id);
  check("sent back: rejected here, marked sent back, with what to correct", row1?.status === "rejected" && row1?.decision?.sentBack === true && row1?.decision?.reason === why, j(row1?.decision));
  check("…the accountant is told it went back to the CS", /Sent back — the CS sees why/.test(sent.message ?? ""), sent.message);
  check("…its history says so", (row1?.events ?? []).some((e: any) => e.text === `Sent back to correct: ${why}`), j(row1?.events));
  const tsb = await tcTxs.findOne({ _id: new Types.ObjectId(sb.externalId) });
  check("Tetra Commission has it rejected, marked sent back, with the reason", tsb?.status === "REJECTED" && tsb?.finance_approval?.sent_back === true && tsb?.rejection_reason === why, j({ s: tsb?.status, fa: tsb?.finance_approval }));
  const { approvalList } = await import("../modules/approvals/approvals.service");
  const page = await approvalList({ ...auth } as never, { status: "all", type: "tetra_deposit", page: 1, pageSize: 100 } as never);
  const ar = page.rows.find((x) => x.id === sb.id);
  check("on Approvals it reads Sent back (like an invoice), and bonuses say they are bonuses", ar?.status === "returned" && ar?.bonus === true, j(ar));
  const up = await arrive({ type: "COURSE_UPGRADE", amountMinor: 10_000, currency: "AED", student: student("STU-SB2"), coursePayment: upgradeCp(new Types.ObjectId().toString(), 20_000) });
  const refused = await svc.decideTetraDeposit(auth as never, up.id, { decision: "rejected", reason: "Not a bonus at all", sentBack: true } as never).then(() => "decided", (e: Error) => e.message);
  check("only a bonus can be sent back — anything else is refused, and stays pending", /Only a bonus can be sent back/.test(refused) && (await row(up.id))?.status === "pending", refused);
  // The CS corrects it in Tetra Commission and sends it again: a new request, naming the one sent back.
  const again = await arrive({ type: "BONUS", amountMinor: 30_000, currency: "USD", student: student("STU-SB"), resubmitOf: sb.externalId, resubmitReason: why });
  const dto = (await svc.listTetraDeposits(ORG, "waiting")).find((d: any) => d.id === again.id) as any;
  check("sent again: waiting for a decision, saying it was corrected after being sent back, and which request it replaces",
    dto?.status === "pending" && dto?.resubmit?.reason === why && dto?.resubmit?.previousId === sb.id, j(dto?.resubmit));
}

/* ── 9. A Bangalore team's bonus, in rupees (the user, 2026-10-15) ──────── */
step("9. A Bangalore team's bonus: the Bangalore organization's, in rupees");
{
  const blr = await Organization.create({ name: "Bangalore E2E", baseCurrency: "INR" });
  const BLR = String(blr._id);
  const authBlr = { ...auth, organizationId: BLR };
  // Bangalore's accountant approves it there, a member of that organization.
  await User.updateOne({ _id: asha._id }, { $push: { memberships: { organizationId: blr._id, roleId: new Types.ObjectId(), status: "active" } } });
  const sv = student("STU-5000");
  /** J Vijay's: INR 150,000 by bank transfer, MSNR part payment, $1,000 bonus, at Tetra Commission's ₹27.248 per AED. */
  const cpOf = (extra: Record<string, unknown> = {}) => ({ product: "MSNR", kind: "partial", withBonus: true, bonusUsd: 1000, paidTodayAed: 5505, holdAed: 1505, balanceAed: 6495, paidBeforeAed: 0, inrPerAed: 27.247956, paidOn: "2026-10-14", ...extra });
  const arriveBlr = async (amountMinor: number, cp: Record<string, unknown>, usd: number) => {
    const externalId = new Types.ObjectId();
    const input = inboundTetraDepositSchema.parse({ externalId: String(externalId), type: "BONUS", amountMinor, currency: "INR", amountOriginal: amountMinor / 100, amountCurrency: "INR", academy: "bangalore", student: sv, team: "Banglore Team", requestedBy: "Glorita", paymentMethod: "Bank Transfer", screenshotUrl: "https://files.e2e.test/r.png", coursePayment: cp });
    await tcTxs.insertOne({ _id: externalId, type: "BONUS", status: "PENDING", student_id: sv.id, student_name: sv.name, amount_usd: usd, amount_currency: "INR", amount_original: amountMinor / 100, fx_rate_usd_per_inr: 0.01, finance_approval: { state: "sent", org: "bangalore", currency: "INR", amount_minor: amountMinor }, course_payment: { product: "MSNR", bonus_usd: 1000 } });
    return svc.intakeTetraDeposit(BLR, input);
  };
  const v1 = await arriveBlr(15_000_000, cpOf(), 1500);
  check("received in the Bangalore organization, INR 150,000, said to be Bangalore's, with its rate",
    v1.currency === "INR" && v1.amountMinor === 15_000_000 && v1.academy === "bangalore" && v1.coursePayment?.inrPerAed === 27.247956, j({ c: v1.currency, a: v1.amountMinor, ac: v1.academy, r: v1.coursePayment?.inrPerAed }));
  check("waiting in Bangalore's queue, not Delta HQ's",
    (await svc.listTetraDeposits(BLR, "waiting")).some((d) => d.id === v1.id) && !(await svc.listTetraDeposits(ORG, "waiting")).some((d) => d.id === v1.id));
  const done = await svc.decideTetraDeposit(authBlr as never, v1.id, { decision: "approved", amountMinor: 15_000_000, transactionId: "Y2M-E2E-1", paymentMethod: "bank_transfer", mt5Login: "", note: "INR transaction" } as never);
  const inv = await invoiceOf(v1.id);
  check("approved: an invoice made in the Bangalore organization, in rupees", !!inv && String(inv.organizationId) === BLR && inv.currency === "INR" && (await row(v1.id))?.courseInvoice?.created === true, j({ org: inv?.organizationId, cur: inv?.currency }));
  check("for the rupees paid plus the AED 6,495 balance at ₹27.248 (₹176,975.47): ₹326,975.47",
    inv?.totalMinor === 32_697_547 && inv?.amountPaidMinor === 15_000_000 && inv?.balanceMinor === 17_697_547, j({ t: inv?.totalMinor, p: inv?.amountPaidMinor, b: inv?.balanceMinor }));
  const pay = (inv?.payments ?? [])[0];
  check("the payment is INR 150,000 with a receipt number, paid on the day collected", pay?.amountMinor === 15_000_000 && /^RCT-\d+/.test(pay?.receiptNumber ?? "") && new Date(pay?.paidOn).toISOString().slice(0, 10) === "2026-10-14", j(pay));
  check("the note says it is Bangalore's, in rupees at Tetra Commission's rate", /Bangalore — rupees at 27\.2480 per AED/.test(String(inv?.notes ?? "")), String(inv?.notes));
  check("the accountant is told", /invoice made/.test(done.message ?? ""), done.message);
  const t1 = await tcTxs.findOne({ _id: new Types.ObjectId(v1.externalId) });
  check("Tetra Commission: still $1,500 paid (the rupees came back the same), the invoice in rupees, waiting for its broker admin",
    t1?.amount_usd === 1500 && t1?.requested_amount_usd === undefined && t1?.course_invoice?.currency === "INR" && t1?.course_invoice?.balance_minor === 17_697_547 && t1?.status === "PENDING" && t1?.finance_approval?.decision === "approved",
    j({ usd: t1?.amount_usd, ci: t1?.course_invoice, s: t1?.status }));
  // The next payment for the course goes on the same rupee invoice.
  const v2 = await arriveBlr(5_000_000, cpOf({ paidTodayAed: 1835, paidBeforeAed: 5505, holdAed: 0, balanceAed: 4660, bonusUsd: 500, paidOn: "2026-10-15" }), 500);
  await svc.decideTetraDeposit(authBlr as never, v2.id, { decision: "approved", amountMinor: 5_000_000, transactionId: "Y2M-E2E-2", paymentMethod: "", mt5Login: "", note: "" } as never);
  const inv2 = await invoiceOf(v2.id);
  check("the next payment goes on the same invoice: ₹200,000 paid, ₹126,975.47 left", String(inv2?._id) === String(inv?._id) && inv2?.amountPaidMinor === 20_000_000 && inv2?.balanceMinor === 12_697_547, j({ same: String(inv2?._id) === String(inv?._id), p: inv2?.amountPaidMinor, b: inv2?.balanceMinor }));
  // An accountant who corrects the rupees: Tetra Commission turns them back into dollars at its rate.
  const v3 = await arriveBlr(1_000_000, cpOf({ paidTodayAed: 367, paidBeforeAed: 7340, holdAed: 0, balanceAed: 4293, bonusUsd: 0, paidOn: "2026-10-15" }), 100);
  await svc.decideTetraDeposit(authBlr as never, v3.id, { decision: "approved", amountMinor: 900_000, transactionId: "Y2M-E2E-3", paymentMethod: "", mt5Login: "", note: "" } as never);
  const t3 = await tcTxs.findOne({ _id: new Types.ObjectId(v3.externalId) });
  const inv3 = await invoiceOf(v3.id);
  check("corrected to ₹9,000: ₹9,000 on the invoice, and Tetra Commission has $90 (the $100 asked kept)",
    (inv3?.payments ?? []).some((p: any) => p.amountMinor === 900_000) && t3?.amount_usd === 90 && t3?.requested_amount_usd === 100, j({ usd: t3?.amount_usd, req: t3?.requested_amount_usd }));
}

/* ── 10. Moving Bangalore bonuses that came to Delta HQ (the user, 2026-10-15) ── */
step("10. The move: Bangalore bonuses approved in Delta HQ go to Bangalore, in rupees");
{
  const { moveBangaloreBonuses } = await import("./move-bangalore-bonuses");
  const blr = await Organization.findOne({ name: "Bangalore E2E" }).lean<any>();
  const BLR = String(blr._id);
  // As before 2026-10-15: J Vijay's bonus came to Delta HQ in dollars ($1,500 = INR 150,000), approved onto an AED invoice.
  const sj = student("STU-6000");
  const cp = { product: "MSNR", kind: "partial", withBonus: true, bonusUsd: 1000, paidTodayAed: 5505, holdAed: 1505, balanceAed: 6495, paidOn: "2026-10-14" };
  const old = await arrive({ type: "BONUS", amountMinor: 150_000, currency: "USD", amountOriginal: 150000, amountCurrency: "INR", team: "Banglore Team", student: sj, coursePayment: cp });
  await approve(old.id, 150_000);
  const hqInv = await invoiceOf(old.id);
  check("before: an AED invoice in Delta HQ for it", hqInv?.currency === "AED" && String(hqInv?.organizationId) === ORG && (hqInv?.payments ?? []).length === 1, j({ c: hqInv?.currency }));
  // …and one still pending there, and a Dubai team's that must stay.
  const pend = await arrive({ type: "BONUS", amountMinor: 50_000, currency: "USD", amountOriginal: 50000, amountCurrency: "INR", team: "Banglore Team", student: student("STU-6001"), coursePayment: { ...cp, paidTodayAed: 1835 } });
  const dubai = await arrive({ type: "BONUS", amountMinor: 54_496, currency: "USD", team: "Team Dubai", student: student("STU-6002"), coursePayment: { ...cp, paidTodayAed: 2000 } });

  const dry = await moveBangaloreBonuses({ write: false, bangaloreOrgId: BLR, email: false });
  const dryOf = (id: string) => dry.rows.find((r) => r.id === id);
  check("dry run: it would move the approved one (payment off the HQ invoice, voided) and the pending one",
    /would be payment .* off .*\(voided\); new rupee invoice/.test(dryOf(old.id)?.outcome ?? "") && /would be moved/.test(dryOf(pend.id)?.outcome ?? ""), j(dry.rows));
  check("…not the Dubai team's", !dryOf(dubai.id));
  check("…and wrote nothing", String((await row(old.id))?.organizationId) === ORG && (await Invoice.findById(hqInv._id).lean<any>())?.status !== "void");

  const done = await moveBangaloreBonuses({ write: true, bangaloreOrgId: BLR, email: false });
  check("written: both moved", done.rows.filter((r) => r.outcome.startsWith("moved")).length === 2, j(done.rows));
  const hqAfter = await Invoice.findById(hqInv._id).lean<any>();
  check("the Delta HQ invoice is voided, its payment taken off, its number kept", hqAfter?.status === "void" && (hqAfter?.payments ?? []).length === 0 && hqAfter?.invoiceNumber === hqInv.invoiceNumber, j({ s: hqAfter?.status }));
  const moved = await row(old.id);
  check("the approved one is Bangalore's now, in rupees: ₹150,000 asked and approved", String(moved?.organizationId) === BLR && moved?.currency === "INR" && moved?.amountMinor === 15_000_000 && moved?.decision?.approvedAmountMinor === 15_000_000 && moved?.academy === "bangalore", j({ o: moved?.organizationId, c: moved?.currency, a: moved?.amountMinor }));
  const blrInv = await invoiceOf(old.id);
  check("on a new rupee invoice in Bangalore: ₹150,000 paid, ₹176,975.47 left, a new receipt", String(blrInv?.organizationId) === BLR && blrInv?.currency === "INR" && blrInv?.amountPaidMinor === 15_000_000 && blrInv?.balanceMinor === 17_697_547 && /^RCT-/.test(moved?.courseInvoice?.receiptNumber ?? ""), j({ c: blrInv?.currency, p: blrInv?.amountPaidMinor, b: blrInv?.balanceMinor }));
  check("its history says it moved", (moved?.events ?? []).some((e: any) => e.kind === "moved" && /voided/.test(e.text)), j(moved?.events?.slice(-2)));
  const pmoved = await row(pend.id);
  check("the pending one waits in Bangalore, ₹50,000", String(pmoved?.organizationId) === BLR && pmoved?.status === "pending" && pmoved?.amountMinor === 5_000_000 && (await svc.listTetraDeposits(BLR, "waiting")).some((d) => d.id === pend.id));
  check("the Dubai team's is untouched", String((await row(dubai.id))?.organizationId) === ORG);
  // Tetra Commission hears again, with the new invoice — the worker's pass.
  await svc.drainTetraDepositDecisions();
  const tj = await tcTxs.findOne({ _id: new Types.ObjectId(old.externalId) });
  check("Tetra Commission shows the new rupee invoice", tj?.course_invoice?.currency === "INR" && tj?.course_invoice?.invoice_number === blrInv?.invoiceNumber, j(tj?.course_invoice));
  const again = await moveBangaloreBonuses({ write: true, bangaloreOrgId: BLR, email: false });
  check("run again: nothing left to move", again.rows.length === 0, j(again.rows));
}

await mongoose.disconnect();
await tc.close();
console.log(`\n${failures ? "\x1b[31m" : "\x1b[32m"}${checks - failures}/${checks} checks passed\x1b[0m`);
process.exit(failures ? 1 : 0);
