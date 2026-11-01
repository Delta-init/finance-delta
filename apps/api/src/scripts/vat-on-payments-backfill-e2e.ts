/**
 * scripts/vat-on-payments-backfill.ts (the user, 2026-11-01: "backfill October month also" — only October, no email),
 * against a scratch database.
 *
 * What it proves: the dry run lists October's approved part-paid enrolments in the organization with the setting on,
 * each payment's tax invoice numbered in the order paid across invoices, with its VAT (the clearing payment taking the
 * rest), and leaves out one paid in full at the close, one in September, one not approved, one void, the organization
 * with the setting off, and lists — but leaves — one whose close never said what was collected; nothing is written;
 * --expect with the wrong count is refused; --write makes them pro-formas with those numbers and emails nobody; the
 * VAT report for October then counts the tax invoices; a second run has nothing to do; the undo file puts them back.
 *
 * Run through scripts/vat-on-payments-backfill-e2e.sh (throwaway mongod, no .env anywhere).
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
const { backfillVatOnPayments, undoVatOnPaymentsBackfill } = await import("./vat-on-payments-backfill");
const { getVATReport } = await import("../modules/reports/reports.service");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const show = (v: unknown) => JSON.stringify(v).slice(0, 700);

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();
const db = mongoose.connection.db!;

const ON = new Types.ObjectId(), OFF = new Types.ObjectId(), CUST = new Types.ObjectId();
await db.collection("organizations").insertMany([
  { _id: ON, name: "Delta HQ", baseCurrency: "AED", vatOnPayments: true },
  { _id: OFF, name: "Elsewhere", baseCurrency: "AED" },
]);
const vat = (g: number) => Math.round((g * 5) / 105);
const at = (d: string) => new Date(`${d}T00:00:00.000Z`);
let n = 0;
const pay = (amountMinor: number, d: string) => ({ _id: new Types.ObjectId(), method: "card", amountMinor, paidOn: at(d), reference: "", notes: "" });
const inv = (o: Record<string, any>) => {
  const total = o.total ?? 225_000; delete o.total;
  const payments = o.payments ?? [];
  const paid = payments.reduce((s: number, p: any) => s + p.amountMinor, 0);
  return {
    _id: new Types.ObjectId(), organizationId: ON, invoiceNumber: `IN-${String(++n).padStart(5, "0")}`, customerId: CUST, customerName: `Student ${n}`,
    issueDate: at("2026-10-10"), dueDate: at("2026-10-10"), currency: "AED", exchangeRate: 1, taxInclusive: true, status: paid >= total ? "paid" : "partial",
    lineItems: [{ description: "Course", quantity: 1, unitPriceMinor: total, discountPct: 0, taxes: [{ code: "VAT", rate: 5, amountMinor: vat(total) }], lineSubtotalMinor: total - vat(total), discountMinor: 0, taxableMinor: total - vat(total), taxTotalMinor: vat(total), lineTotalMinor: total }],
    subtotalMinor: total - vat(total), discountTotalMinor: 0, taxBreakdown: [{ code: "VAT", rate: 5, amountMinor: vat(total) }], taxTotalMinor: vat(total), roundOffMinor: 0,
    totalMinor: total, baseTotalMinor: total, amountPaidMinor: paid, balanceMinor: total - paid, approval: { state: "approved" }, external: { source: "crm", externalId: `close-${n}`, flags: [] },
    createdAt: at("2026-10-10"), updatedAt: at("2026-10-10"),
    ...o, payments, enrolment: { course: "Course", modeOfStudy: "online", language: "English", meetingBy: "Rep", ...(o.enrolment ?? {}) },
  };
};
const part = (paid: number) => ({ declaredPaidMinor: paid, declaredPaymentMethod: "card", declaredPayments: [{ method: "card", amountMinor: paid, paidOn: "2026-10-10" }] });
// A: 1,125 of 2,250 at the close on 12 Oct, the rest on 3 Nov. B: 1,000 of 2,250 on 5 Oct, still owing. C: older shape, 500 of 1,050 on 20 Oct.
const A = inv({ issueDate: at("2026-10-12"), enrolment: part(112_500), payments: [pay(112_500, "2026-10-12"), pay(112_500, "2026-11-03")] });
const B = inv({ issueDate: at("2026-10-05"), enrolment: part(100_000), payments: [pay(100_000, "2026-10-05")] });
const C = inv({ issueDate: at("2026-10-20"), total: 105_000, enrolment: { declaredPaidMinor: 50_000, declaredPaymentMethod: "cash" }, payments: [pay(50_000, "2026-10-20")] });
const FULL = inv({ enrolment: part(225_000), payments: [pay(225_000, "2026-10-10")] });
const SEPT = inv({ issueDate: at("2026-09-28"), enrolment: part(100_000), payments: [pay(100_000, "2026-09-28")] });
const PENDING = inv({ approval: { state: "pending" }, status: "draft", enrolment: part(100_000) });
const VOID = inv({ status: "void", enrolment: part(100_000), payments: [pay(100_000, "2026-10-10")] });
const ELSEWHERE = inv({ organizationId: OFF, enrolment: part(100_000), payments: [pay(100_000, "2026-10-10")] });
const UNSAID = inv({ enrolment: {}, payments: [pay(225_000, "2026-10-15")] });
await db.collection("invoices").insertMany([A, B, C, FULL, SEPT, PENDING, VOID, ELSEWHERE, UNSAID] as any[]);
const snap = async () => JSON.stringify(await db.collection("invoices").find({}).sort({ invoiceNumber: 1 }).toArray());
const before = await snap();
const octBefore = (await getVATReport(String(ON), "2026-10-01", "2026-10-31")).outputTaxMinor;

step("1. The dry run");
let r = await backfillVatOnPayments({ write: false });
const of = (num: string) => r.rows.find((x) => x.invoice === num);
check("lists October's three part-paid closes, the one with no word on what was collected left out",
  r.rows.map((x) => `${x.invoice}:${x.outcome}`).sort().join(",") === [`${A.invoiceNumber}:would change`, `${B.invoiceNumber}:would change`, `${C.invoiceNumber}:would change`, `${UNSAID.invoiceNumber}:left out`].sort().join(","), show(r.rows.map((x) => [x.invoice, x.outcome])));
check("numbers in the order paid: B (5 Oct) TI-00001, A (12 Oct) TI-00002, C (20 Oct) TI-00003, A's 3 Nov payment TI-00004",
  of(B.invoiceNumber)!.taxInvoices.map((t) => t.number).join() === "TI-00001" && of(A.invoiceNumber)!.taxInvoices.map((t) => t.number).join() === "TI-00002,TI-00004"
  && of(C.invoiceNumber)!.taxInvoices.map((t) => t.number).join() === "TI-00003", show(r.rows.map((x) => [x.invoice, x.taxInvoices])));
check("VAT on each: B 47.62 on 1,000; A 53.57 + the rest 53.57 (cleared); C 23.81 on 500",
  of(B.invoiceNumber)!.taxInvoices[0]!.taxMinor === 4_762 && of(A.invoiceNumber)!.taxInvoices[0]!.taxMinor === 5_357 && of(A.invoiceNumber)!.taxInvoices[1]!.taxMinor === vat(225_000) - 5_357
  && of(C.invoiceNumber)!.taxInvoices[0]!.taxMinor === 2_381, show(r.rows.map((x) => x.taxInvoices)));
check("…nothing written", (await snap()) === before);
let refused = ""; try { await backfillVatOnPayments({ write: true, expect: 4 }); } catch (e) { refused = (e as Error).message; }
check("--expect with the wrong count: refused, nothing written", /--expect 4, but 3/.test(refused) && (await snap()) === before, refused);

step("2. Written");
const undoFile = join(mkdtempSync(join(tmpdir(), "vat-backfill-")), "undo.json");
r = await backfillVatOnPayments({ write: true, expect: 3, undoFile });
const a: any = await db.collection("invoices").findOne({ _id: A._id });
check("A: a pro-forma, its payments TI-00002 and TI-00004 with their VAT, nothing emailed", Boolean(a.proforma?.at) && a.payments[0].taxInvoice.number === "TI-00002" && a.payments[1].taxInvoice.number === "TI-00004"
  && a.payments[0].taxInvoice.taxMinor === 5_357 && a.payments[0].taxInvoice.netMinor === 112_500 - 5_357 && !a.payments[0].taxInvoice.emailedAt, show(a.payments));
check("…its own figures untouched", a.totalMinor === 225_000 && a.taxTotalMinor === vat(225_000) && a.amountPaidMinor === 225_000 && a.status === "paid");
check("the others untouched", JSON.stringify(await db.collection("invoices").find({ _id: { $in: [FULL, SEPT, PENDING, VOID, ELSEWHERE, UNSAID].map((x) => x._id) } }).sort({ invoiceNumber: 1 }).toArray())
  === JSON.stringify(JSON.parse(before).filter((x: any) => [FULL, SEPT, PENDING, VOID, ELSEWHERE, UNSAID].some((y) => String(y._id) === String(x._id)))));
check("no emails", (await db.collection("emaillogs").countDocuments({})) === 0);
const oct = (await getVATReport(String(ON), "2026-10-01", "2026-10-31")).outputTaxMinor;
check("October's VAT: the three closes' whole VAT out, their October tax invoices in", oct === octBefore - vat(225_000) * 2 - vat(105_000) + 4_762 + 5_357 + 2_381, show({ octBefore, oct }));
const nov = (await getVATReport(String(ON), "2026-11-01", "2026-11-30")).outputTaxMinor;
check("November: A's 3 Nov tax invoice", nov === vat(225_000) - 5_357, String(nov));
r = await backfillVatOnPayments({ write: false });
check("run again: nothing more", r.rows.every((x) => x.outcome === "left out"), show(r.rows));
const seq: any = await db.collection("sequences").findOne({ organizationId: ON, key: "tax_invoice" });
check("the next tax invoice will be TI-00005", seq?.next === 4, show(seq));

step("3. Undo");
const took = await undoVatOnPaymentsBackfill(undoFile);
// Every field as it was — but its updated time, which any write moves.
const bare = (j: string) => JSON.stringify(JSON.parse(j).map(({ updatedAt: _u, ...x }: any) => x));
check("the pro-forma and tax invoices off again, every field as it was", took === 3 && bare(await snap()) === bare(before), String(took));
check("…October's VAT as it was", (await getVATReport(String(ON), "2026-10-01", "2026-10-31")).outputTaxMinor === octBefore);

await mongoose.disconnect();
console.log(`\n${failures ? "\x1b[31m" : "\x1b[32m"}${checks - failures}/${checks} checks passed\x1b[0m`);
process.exit(failures ? 1 : 0);
