/**
 * Replacing a payment's receipt while editing it (the user, 2026-11-04: the wrong file was on a payment, and the Edit
 * Payment dialog had no way to change it — "also it will reflect on the commission portal").
 *
 * What it proves, through the real route (PATCH /invoices/:id/payments/:paymentId, sent as a form with the file):
 *   - a payment recorded from the close: its receipt is replaced, and so are the close's copies of that same file —
 *     the declared payment's receipt and the invoice's attachment — so what CS Portal is sent holds the new file and
 *     nowhere the old one; the amounts are untouched;
 *   - a close paid in two parts: only the replaced payment's file changes, the other payment's stays, and stays the
 *     close's receipt;
 *   - a payment with finance's own receipt: replaced, the invoice's other attachments untouched;
 *   - a payment with no receipt gets one;
 *   - an edit without a file (plain JSON, as before) keeps the receipt;
 *   - an edit refused (more than the invoice) stores nothing and changes nothing; a file of a type not taken is refused;
 *   - a voided invoice's payment is refused.
 *
 * File storage is stubbed (no R2): every upload is counted. Auth is stubbed to one admin of the scratch organization.
 * Run through scripts/payment-receipt-replace-e2e.sh (throwaway mongod, no .env anywhere).
 */
import { mock } from "bun:test";
import mongoose, { Types } from "mongoose";
import type { AddressInfo } from "node:net";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}

const ORG = new Types.ObjectId(), USER = new Types.ObjectId(), CUST = new Types.ObjectId();
const uploads: { key: string; mimeType: string; originalName: string; size: number }[] = [];
const FILES = "https://files.e2e.test";
mock.module("../lib/storage", () => ({
  storageConfigured: () => true,
  uploadFile: async (o: { key: string; buffer: Buffer; mimeType: string; originalName: string }) => {
    uploads.push({ key: o.key, mimeType: o.mimeType, originalName: o.originalName, size: o.buffer.byteLength });
    return { key: o.key, url: `${FILES}/${o.key}`, size: o.buffer.byteLength, mimeType: o.mimeType, originalName: o.originalName };
  },
  publicUrlFor: (key: string) => `${FILES}/${key}`,
  deleteFile: async () => undefined,
  headerSafeName: (n: string) => n,
}));
mock.module("../middleware/auth", () => ({
  authenticate: (req: any, _res: unknown, next: () => void) => {
    req.auth = { userId: String(USER), organizationId: String(ORG), role: "admin", permissions: [], isSuperAdmin: true };
    next();
  },
}));
mock.module("../middleware/rbac", () => ({
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAnyPermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireSuperAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const express = (await import("express")).default;
const router = (await import("../modules/invoice/invoice.routes")).default;
const { errorHandler } = await import("../middleware/errorHandler");
const { buildFeeUpdate } = await import("../modules/integrations/commission-fee-update.service");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const show = (v: unknown) => String(JSON.stringify(v)).slice(0, 600);

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();
const db = mongoose.connection.db!;
await db.collection("organizations").insertOne({ _id: ORG, name: "Delta HQ", baseCurrency: "AED" });
await db.collection("customers").insertOne({ _id: CUST, organizationId: ORG, customerCode: "CUST-00001", name: "Student", email: "s@e2e.local", phone: "+971500000000" });

const vat = (g: number) => Math.round((g * 5) / 105);
let n = 0;
const inv = (o: Record<string, any>) => {
  const total = 225_000;
  const paid = (o.payments ?? []).reduce((s: number, p: any) => s + p.amountMinor, 0);
  return {
    _id: new Types.ObjectId(), organizationId: ORG, invoiceNumber: `IN-${String(++n).padStart(5, "0")}`, customerId: CUST, customerName: `Student ${n}`, salespersonId: new Types.ObjectId(), salespersonName: "Rep",
    issueDate: new Date("2026-10-02"), dueDate: new Date("2026-10-02"), currency: "AED", exchangeRate: 1, taxInclusive: true,
    status: paid >= total ? "paid" : paid > 0 ? "partial" : "sent",
    lineItems: [{ description: "Course", quantity: 1, unitPriceMinor: total, discountPct: 0, taxes: [{ code: "VAT", rate: 5, amountMinor: vat(total) }], lineSubtotalMinor: total - vat(total), discountMinor: 0, taxableMinor: total - vat(total), taxTotalMinor: vat(total), lineTotalMinor: total }],
    subtotalMinor: total - vat(total), discountTotalMinor: 0, taxBreakdown: [{ code: "VAT", rate: 5, amountMinor: vat(total) }], taxTotalMinor: vat(total), roundOffMinor: 0,
    totalMinor: total, baseTotalMinor: total, amountPaidMinor: paid, balanceMinor: total - paid, approval: { state: "approved" }, attachments: [],
    createdAt: new Date("2026-10-02"), updatedAt: new Date("2026-10-02"),
    ...o, enrolment: { course: "Course", modeOfStudy: "online", language: "English", meetingBy: "Rep", ...(o.enrolment ?? {}) },
  };
};
const closeFile = (name: string) => ({ name, url: `https://crm-files.e2e.test/enrolment-receipts/${name}`, key: `enrolment-receipts/${name}`, size: 10, mimeType: "image/jpeg" });
const pay = (method: string, amountMinor: number, proof?: { url: string; key: string }) => ({
  _id: new Types.ObjectId(), method, amountMinor, paidOn: new Date("2026-10-02"), reference: "", notes: proof?.key.startsWith("enrolment-receipts/") ? "Collected at the close — recorded on approval" : "",
  accountName: "", chargesMinor: 0, proofUrl: proof?.url ?? "", proofKey: proof?.key ?? "",
});

// A: one payment at the close, its receipt also the close's.
const R = closeFile("close.jpeg");
const A = inv({
  payments: [pay("card", 225_000, R)], attachments: [{ ...R, uploadedAt: new Date("2026-10-02") }],
  enrolment: { declaredPaidMinor: 225_000, declaredPaymentMethod: "card", declaredPayments: [{ method: "card", amountMinor: 225_000, paidOn: "2026-10-02", receipt: R }], declaredPaymentsOnApproval: { state: "recorded" } },
});
// B: the close paid in two parts, each with its receipt.
const R1 = closeFile("cash.jpeg"), R2 = closeFile("card.jpeg");
const B = inv({
  payments: [pay("cash", 100_000, R1), pay("card", 125_000, R2)], attachments: [{ ...R1 }, { ...R2 }],
  enrolment: { declaredPaidMinor: 225_000, declaredPaymentMethod: "cash", declaredPayments: [{ method: "cash", amountMinor: 100_000, paidOn: "2026-10-02", receipt: R1 }, { method: "card", amountMinor: 125_000, paidOn: "2026-10-02", receipt: R2 }] },
});
// C: a payment accounts recorded with finance's own receipt, and an unrelated document on the invoice.
const F = { url: `${FILES}/invoices/${ORG}/x/proof-1-old.png`, key: `invoices/${ORG}/x/proof-1-old.png` };
const DOC = { name: "contract.pdf", url: `${FILES}/invoices/${ORG}/x/contract.pdf`, key: `invoices/${ORG}/x/contract.pdf`, size: 5, mimeType: "application/pdf" };
const C = inv({ payments: [pay("bank_transfer", 100_000, F)], attachments: [DOC] });
// D: a payment with no receipt.
const D = inv({ payments: [pay("cash", 50_000)] });
// V: voided.
const V = inv({ status: "void", payments: [pay("cash", 50_000, F)] });
await db.collection("invoices").insertMany([A, B, C, D, V] as any[]);

const app = express();
app.use(express.json());
app.use("/invoices", router);
app.use(errorHandler);
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const body = (p: any, over: Record<string, unknown> = {}) => ({
  method: p.method, amountMinor: p.amountMinor, paidOn: "2026-10-02", reference: p.reference, notes: p.notes, accountName: "", chargesMinor: 0, ...over,
});
const png = (name = "new receipt.png") => new File([new Uint8Array([137, 80, 78, 71, 1, 2, 3])], name, { type: "image/png" });
async function patchForm(invoice: any, p: any, file: File, over: Record<string, unknown> = {}) {
  const form = new FormData();
  form.append("data", JSON.stringify(body(p, over)));
  form.append("file", file);
  const res = await fetch(`${base}/invoices/${invoice._id}/payments/${p._id}`, { method: "PATCH", body: form });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}
async function patchJson(invoice: any, p: any, over: Record<string, unknown> = {}) {
  const res = await fetch(`${base}/invoices/${invoice._id}/payments/${p._id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body(p, over)) });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}
const load = (x: any) => db.collection("invoices").findOne({ _id: x._id }) as Promise<any>;
const feeOf = (doc: any) => buildFeeUpdate(doc, null, "s@e2e.local");

try {
  step("1. A payment recorded from the close: its receipt replaced");
  let r = await patchForm(A, A.payments[0], png());
  let doc = await load(A);
  const NEW = doc.payments[0].proofUrl as string;
  check("saved (200), the file stored once under the invoice", r.status === 200 && uploads.length === 1 && uploads[0]!.key.startsWith(`invoices/${ORG}/${A._id}/proof-`) && uploads[0]!.mimeType === "image/png", show({ status: r.status, uploads, body: r.json }));
  check("…the payment's receipt is the new file", NEW === `${FILES}/${uploads[0]!.key}` && doc.payments[0].proofKey === uploads[0]!.key, show(doc.payments[0]));
  check("…the answer carries it, for the screen", r.json?.data?.payments?.[0]?.proofUrl === NEW, show(r.json?.data?.payments?.[0]));
  check("…the close's declared payment holds the new file too", doc.enrolment.declaredPayments[0].receipt.url === NEW && doc.enrolment.declaredPayments[0].receipt.name === "new receipt.png", show(doc.enrolment.declaredPayments));
  check("…and the invoice's attachment of it", doc.attachments.length === 1 && doc.attachments[0].url === NEW && doc.attachments[0].key === uploads[0]!.key && doc.attachments[0].name === "new receipt.png", show(doc.attachments));
  check("…the old file is nowhere on the invoice", !JSON.stringify(doc).includes(R.url));
  check("…the money untouched: paid in full, nothing due", doc.payments[0].amountMinor === 225_000 && doc.amountPaidMinor === 225_000 && doc.balanceMinor === 0 && doc.status === "paid", show({ paid: doc.amountPaidMinor, bal: doc.balanceMinor, status: doc.status }));
  let fee = feeOf(doc);
  check("CS Portal is sent the new file as the payment's receipt and the close's", fee.payments[0]?.receipt?.url === NEW && fee.declaredPayments[0]?.receipt?.url === NEW, show(fee));
  check("…and the old one nowhere in what it is sent", !JSON.stringify(fee).includes(R.url), show(fee));

  step("2. A close paid in two parts: one payment's receipt replaced");
  r = await patchForm(B, B.payments[0], png("cash fixed.jpg"));
  doc = await load(B);
  const NEW1 = doc.payments[0].proofUrl as string;
  check("saved, the cash payment has the new file", r.status === 200 && uploads.length === 2 && NEW1 === `${FILES}/${uploads[1]!.key}`, show({ status: r.status, body: r.json }));
  check("…the card payment keeps its own", doc.payments[1].proofUrl === R2.url, show(doc.payments[1]));
  check("…declared: cash's receipt replaced, card's kept", doc.enrolment.declaredPayments[0].receipt.url === NEW1 && doc.enrolment.declaredPayments[1].receipt.url === R2.url, show(doc.enrolment.declaredPayments));
  check("…attachments: cash's replaced, card's kept", doc.attachments[0].url === NEW1 && doc.attachments[1].url === R2.url, show(doc.attachments));
  fee = feeOf(doc);
  check("CS Portal: no old cash file anywhere; the card file is still the close's receipt",
    !JSON.stringify(fee).includes(R1.url) && fee.receipt?.url === R2.url && fee.payments.map((p) => p.receipt?.url).join() === [NEW1, R2.url].join(), show(fee));

  step("3. A payment with finance's own receipt");
  r = await patchForm(C, C.payments[0], png("transfer.png"));
  doc = await load(C);
  check("saved, the new file on the payment", r.status === 200 && doc.payments[0].proofUrl === `${FILES}/${uploads[2]!.key}`, show({ status: r.status, p: doc.payments[0] }));
  check("…the invoice's other document untouched", doc.attachments.length === 1 && doc.attachments[0].url === DOC.url, show(doc.attachments));

  step("4. A payment with no receipt gets one");
  r = await patchForm(D, D.payments[0], png("cash.png"));
  doc = await load(D);
  check("saved, the payment has the file", r.status === 200 && doc.payments[0].proofUrl === `${FILES}/${uploads[3]!.key}`, show({ status: r.status, p: doc.payments[0] }));
  check("…nothing added to the attachments or the close", (doc.attachments ?? []).length === 0 && !(doc.enrolment.declaredPayments ?? []).length, show(doc.attachments));

  step("5. An edit without a file keeps the receipt");
  const before = (await load(A)).payments[0].proofUrl;
  r = await patchJson(A, A.payments[0], { reference: "TXN-1" });
  doc = await load(A);
  check("saved as JSON, as before; the reference changed, the receipt kept, nothing stored", r.status === 200 && doc.payments[0].reference === "TXN-1" && doc.payments[0].proofUrl === before && uploads.length === 4, show({ status: r.status, p: doc.payments[0] }));

  step("6. Refusals change nothing");
  const snapC = JSON.stringify(await load(C));
  r = await patchForm(C, C.payments[0], png(), { amountMinor: 300_000 });
  check("more than the invoice: refused (409), nothing stored, nothing changed", r.status === 409 && uploads.length === 4 && JSON.stringify(await load(C)) === snapC, show({ status: r.status, body: r.json }));
  r = await patchForm(C, C.payments[0], new File(["hello"], "notes.txt", { type: "text/plain" }));
  check("a text file: refused, nothing stored, nothing changed", r.status >= 400 && uploads.length === 4 && JSON.stringify(await load(C)) === snapC, show({ status: r.status, body: r.json }));
  const snapV = JSON.stringify(await load(V));
  r = await patchForm(V, V.payments[0], png());
  check("a voided invoice's payment: refused (409), nothing stored", r.status === 409 && uploads.length === 4 && JSON.stringify(await load(V)) === snapV, show({ status: r.status, body: r.json }));
} finally {
  server.close();
  await mongoose.connection.db!.dropDatabase();
  await mongoose.disconnect();
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
