/**
 * scripts/enrolment-change.ts (the user, 2026-10-31: an approved enrolment moved to a bigger course, paid in more
 * payments), against a scratch database with a stand-in file store.
 *
 * What it proves: without --item it lists the catalogue's matching items; the dry run writes nothing; a price below
 * what would be paid is refused; --write makes the line the new course at its price (approval kept), replaces the
 * first payment's receipt, records each payment with its receipt and a receipt number (the invoice paid), emails each
 * receipt, says the new course on the enrolment with every payment collected, and queues the LMS course it adds; the
 * same payments again are refused; the undo file takes the payments off and puts the rest back.
 *
 * Run through scripts/enrolment-change-e2e.sh (throwaway mongod, no .env anywhere).
 */
import mongoose, { Types } from "mongoose";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}
const { changeEnrolment, undoEnrolmentChange, parsePay } = await import("./enrolment-change");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const show = (v: unknown) => JSON.stringify(v).slice(0, 400);
async function refused(p: Promise<unknown>, like: RegExp): Promise<string> {
  try { await p; return "not refused"; } catch (e) { const m = (e as Error).message; return like.test(m) ? "" : m; }
}

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();
const db = mongoose.connection.db!;

const ORG = new Types.ObjectId(), CUST = new Types.ObjectId(), C1 = new Types.ObjectId(), C2 = new Types.ObjectId();
const MBT = "market-break-out-trading-program", DWT = "delta-wave-theory-trading-programme";
await db.collection("organizations").insertOne({ _id: ORG, name: "Delta HQ", baseCurrency: "AED" });
await db.collection("customers").insertOne({ _id: CUST, organizationId: ORG, customerCode: "CUST-00001", name: "Test Student", email: "student@e2e.local", phone: "+971500000000" });
await db.collection("items").insertMany([
  { _id: C1, organizationId: ORG, name: "MBT (with credit)", sku: "C1", unitPriceMinor: 225_000, lmsCourseSlug: MBT, lmsCourseSlugs: [MBT], isActive: true, type: "service" },
  { _id: C2, organizationId: ORG, name: "MBT + DWT (with credit)", sku: "C2", unitPriceMinor: 550_000, lmsCourseSlug: MBT, lmsCourseSlugs: [MBT, DWT], isActive: true, type: "service" },
]);
const vat = (gross: number) => Math.round((gross * 5) / 105);
const INV = new Types.ObjectId(), P1 = new Types.ObjectId();
const OLD_PROOF = "https://files.example.test/old-receipt.jpeg";
await db.collection("invoices").insertOne({
  _id: INV, organizationId: ORG, invoiceNumber: "IN-00001", customerId: CUST, customerName: "Test Student", salespersonId: new Types.ObjectId(), salespersonName: "Rep",
  issueDate: new Date("2026-10-31"), dueDate: new Date("2026-10-31"), currency: "AED", exchangeRate: 1, taxInclusive: true, status: "paid",
  lineItems: [{ description: "COURSE 1 - TEST (WITH CREDIT)", quantity: 1, unitPriceMinor: 225_000, discountPct: 0, itemId: C1, taxes: [{ code: "VAT", rate: 5, amountMinor: vat(225_000) }],
    lineSubtotalMinor: 225_000 - vat(225_000), discountMinor: 0, taxableMinor: 225_000 - vat(225_000), taxTotalMinor: vat(225_000), lineTotalMinor: 225_000 }],
  subtotalMinor: 225_000 - vat(225_000), discountTotalMinor: 0, taxBreakdown: [{ code: "VAT", rate: 5, amountMinor: vat(225_000) }], taxTotalMinor: vat(225_000), roundOffMinor: 0,
  totalMinor: 225_000, baseTotalMinor: 225_000, amountPaidMinor: 225_000, balanceMinor: 0,
  approval: { state: "approved" },
  payments: [{ _id: P1, method: "tabby", amountMinor: 225_000, paidOn: new Date("2026-10-31"), reference: "", notes: "", proofUrl: OLD_PROOF, proofKey: "old-key" }],
  enrolment: { course: "COURSE 1 - TEST (WITH CREDIT)", modeOfStudy: "online", language: "English", meetingBy: "Rep", lmsCourseSlug: MBT,
    courses: [{ name: "COURSE 1 - TEST (WITH CREDIT)", lmsCourseSlugs: [MBT] }], declaredPaidMinor: 225_000, declaredPaymentMethod: "tabby",
    declaredPayments: [{ method: "tabby", amountMinor: 225_000, paidOn: "2026-10-31", receipt: { name: "old.jpeg", url: OLD_PROOF, key: "old-key" } }], crm: "delta" },
  external: { source: "crm", externalId: "close-1", flags: [] },
  createdAt: new Date("2026-10-31"), updatedAt: new Date("2026-10-31"),
});
await db.collection("lmsprovisions").insertOne({ organizationId: ORG, invoiceId: INV, invoiceNumber: "IN-00001", payload: { email: "student@e2e.local", courseSlug: MBT, paymentStatus: "paid" }, status: "sent", source: "crm" });

const dir = mkdtempSync(join(tmpdir(), "enrolment-change-e2e-"));
const file = (n: string) => { const p = join(dir, n); writeFileSync(p, Buffer.from(`fake ${n}`)); return p; };
const r1 = file("receipt-1.jpeg"), r2 = file("receipt-2.jpeg"), r3 = file("receipt-3.jpeg");
const uploads: string[] = [];
const upload = async (key: string, f: { buffer: Buffer; mimeType: string; originalName: string }) => { uploads.push(f.originalName); return { url: `https://files.example.test/${key}`, key, size: f.buffer.length, mimeType: f.mimeType, originalName: f.originalName }; };
const NEW = "COURSE 2 - MBT + DWT (WITH CREDIT)";
const base = { invoice: "IN-00001", course: NEW, priceMinor: 550_000, proof: r1, payments: [parsePay(`2250|tabby|2026-10-31|ORDER-2|${r2}`), parsePay(`1000|tabby|2026-10-31|ORDER-3|${r3}`)], email: true, upload };
const snapshot = async () => db.collection("invoices").findOne({ _id: INV });
const before = await snapshot();

step("1. Choosing the item, the dry run, refusals");
let r = await changeEnrolment({ ...base, write: false });
check("without --item: the catalogue items with the course's words listed", r.items?.length === 1 && /MBT \+ DWT/.test(r.items[0] ?? "") && r.items[0]!.includes(String(C2)), show(r.items));
r = await changeEnrolment({ ...base, item: String(C2), write: false });
check("the dry run says the line, the receipt, both payments with the email, the total paid, and the LMS course it opens",
  r.lines.some((l) => /COURSE 1 - TEST.*→ .*COURSE 2 - MBT \+ DWT.*5,500/.test(l)) && r.lines.some((l) => /receipt-1\.jpeg in place/.test(l))
  && r.lines.filter((l) => /^payment:/.test(l)).length === 2 && r.lines.some((l) => /emailed to student@e2e\.local/.test(l))
  && r.lines.some((l) => /5,500\.00 paid, AED 0\.00 owed/.test(l)) && r.lines.some((l) => l.includes(`opens ${DWT}`)), show(r.lines));
check("…nothing written, nothing uploaded", JSON.stringify(await snapshot()) === JSON.stringify(before) && uploads.length === 0);
check("a price below what would be paid: refused", (await refused(changeEnrolment({ ...base, item: String(C2), priceMinor: 400_000, write: false }), /too low/)) === "");
check("a payment line written wrong: refused", (await refused(Promise.resolve().then(() => parsePay("2250|bitcoin|2026-10-31|X|f")), /method/)) === "");
check("a file that isn't there: refused", (await refused(changeEnrolment({ ...base, item: String(C2), proof: join(dir, "nope.jpeg"), write: false }), /No such file/)) === "");

step("2. Written");
const undoFile = join(dir, "undo.json");
r = await changeEnrolment({ ...base, item: String(C2), write: true, undoFile });
const inv: any = await snapshot();
check("the line is the new course at 5,500, its item, VAT inside; approval kept", inv.lineItems.length === 1 && inv.lineItems[0].description === NEW && String(inv.lineItems[0].itemId) === String(C2)
  && inv.totalMinor === 550_000 && Math.abs(inv.taxTotalMinor - vat(550_000)) <= 1 && inv.approval?.state === "approved", show({ l: inv.lineItems, t: inv.totalMinor, a: inv.approval }));
check("three payments, 5,500 paid, nothing owed, paid", inv.payments.length === 3 && inv.amountPaidMinor === 550_000 && inv.balanceMinor === 0 && inv.status === "paid", show({ n: inv.payments.length, p: inv.amountPaidMinor, b: inv.balanceMinor, s: inv.status }));
check("the first payment's receipt replaced", inv.payments[0].proofUrl.includes("receipt-1.jpeg") && inv.payments[0].proofKey.includes("receipt-1.jpeg"), show(inv.payments[0]));
check("each new payment: its amount, method, reference, receipt file and a receipt number",
  inv.payments[1].amountMinor === 225_000 && inv.payments[1].reference === "ORDER-2" && inv.payments[1].proofUrl.includes("receipt-2.jpeg") && /^RCT-\d+/.test(inv.payments[1].receiptNumber ?? "")
  && inv.payments[2].amountMinor === 100_000 && inv.payments[2].method === "tabby" && inv.payments[2].proofUrl.includes("receipt-3.jpeg") && /^RCT-\d+/.test(inv.payments[2].receiptNumber ?? "")
  && inv.payments[1].receiptNumber !== inv.payments[2].receiptNumber, show(inv.payments.slice(1)));
check("the enrolment says the new course, both LMS courses, 5,500 collected, each payment with its receipt",
  inv.enrolment.course === NEW && JSON.stringify(inv.enrolment.courses) === JSON.stringify([{ name: NEW, lmsCourseSlugs: [MBT, DWT] }]) && inv.enrolment.declaredPaidMinor === 550_000
  && inv.enrolment.declaredPayments.length === 3 && inv.enrolment.declaredPayments[0].receipt.name === "receipt-1.jpeg" && inv.enrolment.declaredPayments[2].receipt.name === "receipt-3.jpeg"
  && inv.enrolment.modeOfStudy === "online", show(inv.enrolment));
const lp: any = await db.collection("lmsprovisions").findOne({ invoiceId: INV });
check("the LMS course it adds is queued to open", lp.extraCourses?.length === 1 && lp.extraCourses[0].slug === DWT && lp.extraCourses[0].status === "pending", show(lp.extraCourses));
const mails = await db.collection("emaillogs").find({ kind: "payment_receipt" }).toArray();
check("a receipt email for each new payment, to the student", mails.length === 2 && mails.every((m: any) => JSON.stringify(m.to).includes("student@e2e.local")) && mails.some((m: any) => /RCT-.*2,250/.test(m.subject)), show(mails.map((m: any) => [m.to, m.subject])));
check("three files uploaded", uploads.length === 3, show(uploads));
check("the same payments again: refused", (await refused(changeEnrolment({ ...base, item: String(C2), write: false }), /Recorded already/)) === "");

step("3. Undo");
const out = await undoEnrolmentChange(undoFile);
const back: any = await snapshot();
check("the payments it recorded taken off, the rest put back as it was",
  back.payments.length === 1 && back.payments[0].proofUrl === OLD_PROOF && back.totalMinor === 225_000 && back.amountPaidMinor === 225_000 && back.balanceMinor === 0 && back.status === "paid"
  && back.lineItems[0].description === "COURSE 1 - TEST (WITH CREDIT)" && back.enrolment.course === "COURSE 1 - TEST (WITH CREDIT)" && back.enrolment.declaredPayments.length === 1, show({ out, p: back.payments.length, t: back.totalMinor, s: back.status }));
check("…and the LMS course no longer queued", ((await db.collection("lmsprovisions").findOne({ invoiceId: INV })) as any).extraCourses.length === 0);

await new Promise((r) => setTimeout(r, 500));
await mongoose.disconnect();
console.log(`\n${failures ? "\x1b[31m" : "\x1b[32m"}${checks - failures}/${checks} checks passed\x1b[0m`);
process.exit(failures ? 1 : 0);
