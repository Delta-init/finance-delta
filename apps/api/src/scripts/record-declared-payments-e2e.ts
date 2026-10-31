/**
 * scripts/record-declared-payments.ts (the user, 2026-11-01: an enrolment approved on 2 October had what was collected
 * at the close but nothing on its invoice), against a scratch database.
 *
 * What it proves: the dry run lists each approved enrolment with nothing paid on it and what its close collected —
 * a list of payments, or the older one amount and method with the close's receipt as an attachment — and leaves out
 * one paid already, one whose approval dealt with them, one not approved, one with nothing collected; one its approval
 * would leave out (more than the invoice) is listed as left out; nothing is written; --expect with the wrong count is
 * refused; --write records them as approval does (method, the day paid, the receipt, the status); a second run has
 * nothing to do; the undo file takes them off again.
 *
 * Run through scripts/record-declared-payments-e2e.sh (throwaway mongod, no .env anywhere).
 */
import mongoose, { Types } from "mongoose";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}
const { recordDeclared, undoRecordDeclared } = await import("./record-declared-payments");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const show = (v: unknown) => JSON.stringify(v).slice(0, 500);

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();
const db = mongoose.connection.db!;

const ORG = new Types.ObjectId(), CUST = new Types.ObjectId();
await db.collection("organizations").insertOne({ _id: ORG, name: "Delta HQ", baseCurrency: "AED" });
await db.collection("customers").insertOne({ _id: CUST, organizationId: ORG, customerCode: "CUST-00001", name: "Student", email: "s@e2e.local", phone: "+971500000000" });
const vat = (g: number) => Math.round((g * 5) / 105);
const RECEIPT = { name: "close.jpeg", url: "https://files.example.test/close.jpeg", key: "close-key" };
let n = 0;
const inv = (o: Record<string, any>) => {
  const total = o.total ?? 225_000;
  return {
    _id: new Types.ObjectId(), organizationId: ORG, invoiceNumber: `IN-${String(++n).padStart(5, "0")}`, customerId: CUST, customerName: `Student ${n}`, salespersonId: new Types.ObjectId(), salespersonName: "Rep",
    issueDate: new Date("2026-10-02"), dueDate: new Date("2026-10-02"), currency: "AED", exchangeRate: 1, taxInclusive: true, status: "overdue",
    lineItems: [{ description: "Course", quantity: 1, unitPriceMinor: total, discountPct: 0, taxes: [{ code: "VAT", rate: 5, amountMinor: vat(total) }], lineSubtotalMinor: total - vat(total), discountMinor: 0, taxableMinor: total - vat(total), taxTotalMinor: vat(total), lineTotalMinor: total }],
    subtotalMinor: total - vat(total), discountTotalMinor: 0, taxBreakdown: [{ code: "VAT", rate: 5, amountMinor: vat(total) }], taxTotalMinor: vat(total), roundOffMinor: 0,
    totalMinor: total, baseTotalMinor: total, amountPaidMinor: 0, balanceMinor: total, approval: { state: "approved" }, payments: [], external: { source: "crm", externalId: `close-${n}`, flags: [] },
    createdAt: new Date("2026-10-02"), updatedAt: new Date("2026-10-02"),
    ...o, enrolment: { course: "Course", modeOfStudy: "online", language: "English", meetingBy: "Rep", ...(o.enrolment ?? {}) },
  };
};
const A = inv({ enrolment: { declaredPaidMinor: 225_000, declaredPaymentMethod: "billexpro", declaredPayments: [{ method: "billexpro", amountMinor: 225_000, paidOn: "2026-10-02", receipt: RECEIPT }] } });
const B = inv({ enrolment: { declaredPaidMinor: 150_000, declaredPaymentMethod: "cash" }, attachments: [{ name: "close.jpeg", url: RECEIPT.url, key: RECEIPT.key, mimeType: "image/jpeg", size: 1 }] });
const PAID = inv({ status: "paid", amountPaidMinor: 225_000, balanceMinor: 0, payments: [{ _id: new Types.ObjectId(), method: "card", amountMinor: 225_000, paidOn: new Date("2026-10-02") }], enrolment: { declaredPaidMinor: 225_000, declaredPaymentMethod: "card" } });
const DEALT = inv({ enrolment: { declaredPaidMinor: 225_000, declaredPaymentMethod: "card", declaredPaymentsOnApproval: { state: "skipped", reason: "x" } } });
const PENDING = inv({ approval: { state: "pending" }, status: "draft", enrolment: { declaredPaidMinor: 225_000, declaredPaymentMethod: "card" } });
const NOTHING = inv({ enrolment: { declaredPaidMinor: 0 } });
const TOO_MUCH = inv({ enrolment: { declaredPaidMinor: 300_000, declaredPaymentMethod: "card", declaredPayments: [{ method: "card", amountMinor: 300_000, paidOn: "2026-10-02" }] } });
await db.collection("invoices").insertMany([A, B, PAID, DEALT, PENDING, NOTHING, TOO_MUCH] as any[]);
const snap = async () => JSON.stringify(await db.collection("invoices").find({}).sort({ invoiceNumber: 1 }).toArray());
const before = await snap();

step("1. The dry run");
let r = await recordDeclared({ write: false });
const of = (num: string) => r.rows.find((x) => x.invoice === num);
check("lists the two approved with nothing recorded — the payment list, and the older one amount with the attached receipt",
  of(A.invoiceNumber)?.outcome === "would record" && /AED 2,250\.00 billexpro on 2026-10-02 with its receipt/.test(of(A.invoiceNumber)!.detail)
  && of(B.invoiceNumber)?.outcome === "would record" && /AED 1,500\.00 cash on 2026-10-02 with its receipt/.test(of(B.invoiceNumber)!.detail), show(r.rows));
check("…one with more collected than the invoice: listed, left out, saying why", of(TOO_MUCH.invoiceNumber)?.outcome === "left out" && /more than the invoice/.test(of(TOO_MUCH.invoiceNumber)!.detail), show(of(TOO_MUCH.invoiceNumber)));
check("…paid already, dealt with by its approval, not approved, nothing collected: not listed", r.rows.length === 3, show(r.rows.map((x) => x.invoice)));
check("…nothing written", (await snap()) === before);
let refused = ""; try { await recordDeclared({ write: true, expect: 3 }); } catch (e) { refused = (e as Error).message; }
check("--expect with the wrong count: refused, nothing written", /--expect 3, but 2/.test(refused) && (await snap()) === before, refused);
r = await recordDeclared({ write: false, invoice: A.invoiceNumber });
check("--invoice: just that one", r.rows.length === 1 && r.rows[0]!.invoice === A.invoiceNumber);

step("2. Written");
const undoFile = join(mkdtempSync(join(tmpdir(), "record-declared-")), "undo.json");
r = await recordDeclared({ write: true, expect: 2, undoFile });
const a: any = await db.collection("invoices").findOne({ _id: A._id }), b: any = await db.collection("invoices").findOne({ _id: B._id });
check("the first: its payment recorded as approval does — method, the day, the receipt; paid", a.payments.length === 1 && a.payments[0].method === "billexpro" && a.payments[0].amountMinor === 225_000
  && a.payments[0].proofUrl === RECEIPT.url && new Date(a.payments[0].paidOn).toISOString().startsWith("2026-10-02") && a.status === "paid" && a.balanceMinor === 0 && a.enrolment.declaredPaymentsOnApproval?.state === "recorded", show(a.payments));
check("the second: the one amount, its receipt from the attachment; part paid, 750 owed", b.payments.length === 1 && b.payments[0].method === "cash" && b.payments[0].proofUrl === RECEIPT.url
  && b.status === "partial" && b.balanceMinor === 75_000, show({ p: b.payments, s: b.status, bal: b.balanceMinor }));
check("…the others untouched", JSON.stringify(await db.collection("invoices").find({ _id: { $in: [PAID._id, DEALT._id, PENDING._id, NOTHING._id, TOO_MUCH._id] } }).sort({ invoiceNumber: 1 }).toArray())
  === JSON.stringify(JSON.parse(before).filter((x: any) => [PAID, DEALT, PENDING, NOTHING, TOO_MUCH].some((y) => String(y._id) === String(x._id)))));
r = await recordDeclared({ write: false });
check("run again: nothing more to record", r.rows.every((x) => x.outcome === "left out"), show(r.rows));

step("3. Undo");
const took = await undoRecordDeclared(undoFile);
const a2: any = await db.collection("invoices").findOne({ _id: A._id }), b2: any = await db.collection("invoices").findOne({ _id: B._id });
check("the payments taken off, owing again, their approval free to record them", took === 2 && a2.payments.length === 0 && a2.balanceMinor === 225_000 && b2.payments.length === 0
  && !a2.enrolment.declaredPaymentsOnApproval && (await recordDeclared({ write: false })).rows.filter((x) => x.outcome === "would record").length === 2, show({ took, a: a2.payments, s: a2.status }));

await new Promise((res) => setTimeout(res, 500));
await mongoose.disconnect();
console.log(`\n${failures ? "\x1b[31m" : "\x1b[32m"}${checks - failures}/${checks} checks passed\x1b[0m`);
process.exit(failures ? 1 : 0);
