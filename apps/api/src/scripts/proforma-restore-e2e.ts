/**
 * scripts/proforma-restore.ts (the user, 2026-11-12: "why Pro-formas & tax invoices is nothing … can we backfill it"),
 * against a scratch database left the way a day of quote-based enrolments left the real one.
 *
 * What it proves: the look lists the pro-formas that lost their mark (the day each began from the quote backfill's
 * undo file, else from its first tax invoice), the enrolment and the course invoice approved part paid as one invoice,
 * and the enrolment quotes — and leaves out the one approved before, the one paid in full, the other organization and
 * the quotes made by hand; nothing is written; a wrong --expect is refused; --write puts the marks back, numbers a tax
 * invoice for every payment without one on from the last, in the order paid, the clearing payment taking the rest of
 * the VAT, removes the enrolment quotes and their links and nothing else; Sales → Pro-formas & TIs and the VAT report
 * then see them; a second run has nothing to do; the undo file puts everything back; and after it, a payment recorded
 * through the app gets its tax invoice again.
 *
 * Run through scripts/proforma-restore-e2e.sh (throwaway mongod, no .env anywhere).
 */
import mongoose, { Types } from "mongoose";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}
const { restoreProformas, undoRestoreProformas, findQuoteBackfillUndo } = await import("./proforma-restore");
const { getVATReport } = await import("../modules/reports/reports.service");
const { listProformasAndTaxInvoices } = await import("../modules/invoice/payment-tax-invoice");
const { recordPayment } = await import("../modules/invoice/invoice.service");

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
  { _id: ON, name: "Delta HQ", baseCurrency: "AED", taxRegistrationNumber: "100000000000003", vatOnPayments: true },
  { _id: OFF, name: "Elsewhere", baseCurrency: "AED" },
]);
await db.collection("customers").insertOne({ _id: CUST, organizationId: ON, customerCode: "CUST-00001", name: "Student", email: "s@e2e.local", phone: "+971500000000" });
// TI-00001 … TI-00003 are out already.
await db.collection("sequences").insertOne({ organizationId: ON, key: "tax_invoice", prefix: "TI-", next: 3 });

const vat = (g: number) => Math.round((g * 5) / 105);
const at = (d: string) => new Date(d.length === 10 ? `${d}T00:00:00.000Z` : d);
let n = 0;
const pay = (amountMinor: number, d: string, ti?: { number: string; taxMinor: number; issuedAt: string }) => ({
  _id: new Types.ObjectId(), method: "card", amountMinor, paidOn: at(d), reference: "", notes: "", accountName: "", chargesMinor: 0,
  ...(ti ? { taxInvoice: { number: ti.number, netMinor: amountMinor - ti.taxMinor, taxMinor: ti.taxMinor, issuedAt: at(ti.issuedAt) } } : {}),
});
const inv = (o: Record<string, any>) => {
  const total = o.total ?? 225_000; delete o.total;
  const payments = o.payments ?? [];
  const paid = payments.reduce((s: number, p: any) => s + p.amountMinor, 0);
  const issued = o.issueDate ?? at("2026-10-10");
  const doc: Record<string, any> = {
    _id: new Types.ObjectId(), organizationId: ON, invoiceNumber: `IN-${String(++n).padStart(5, "0")}`, customerId: CUST, customerName: `Student ${n}`, salespersonId: new Types.ObjectId(), salespersonName: "Rep",
    issueDate: issued, dueDate: issued, currency: "AED", exchangeRate: 1, taxInclusive: true, status: paid >= total ? "paid" : "partial",
    lineItems: [{ description: "Course", quantity: 1, unitPriceMinor: total, discountPct: 0, taxes: [{ code: "VAT", rate: 5, amountMinor: vat(total) }], lineSubtotalMinor: total - vat(total), discountMinor: 0, taxableMinor: total - vat(total), taxTotalMinor: vat(total), lineTotalMinor: total }],
    subtotalMinor: total - vat(total), discountTotalMinor: 0, taxBreakdown: [{ code: "VAT", rate: 5, amountMinor: vat(total) }], taxTotalMinor: vat(total), roundOffMinor: 0,
    totalMinor: total, baseTotalMinor: total, amountPaidMinor: paid, balanceMinor: total - paid, approval: { state: "approved", at: issued }, external: { source: "crm", externalId: `close-${n}`, flags: [] },
    createdAt: issued, updatedAt: issued,
    ...o, payments,
  };
  if (o.enrolment !== null) doc.enrolment = { course: "Course", modeOfStudy: "online", language: "English", meetingBy: "Rep", ...(o.enrolment ?? {}) };
  else delete doc.enrolment;
  return doc;
};
const part = (paid: number) => ({ declaredPaidMinor: paid, declaredPaymentMethod: "card", declaredPayments: [{ method: "card", amountMinor: paid, paidOn: "2026-10-10" }] });
const UNTIL = at("2026-11-11T09:54:23.111Z");
const QID1 = new Types.ObjectId(), QID2 = new Types.ObjectId(), QID3 = new Types.ObjectId();

// Pro-formas the quote backfill made ordinary invoices. P1: 2,000 of 5,500, nothing since. P2: 1,125 of 2,250, and 500
// recorded on 12 Nov — no tax invoice, it was no pro-forma then. P3: 500 of 1,050, cleared on 11 Nov, the same.
const P1 = inv({ total: 550_000, issueDate: at("2026-10-20"), enrolment: part(200_000), proformaUntil: UNTIL, payments: [pay(200_000, "2026-10-20", { number: "TI-00001", taxMinor: 9_524, issuedAt: "2026-10-20T10:00:00.000Z" })] });
const P2 = inv({ issueDate: at("2026-10-25"), enrolment: part(112_500), proformaUntil: UNTIL, payments: [pay(112_500, "2026-10-25", { number: "TI-00002", taxMinor: 5_357, issuedAt: "2026-10-25T09:00:00.000Z" }), pay(50_000, "2026-11-12")] });
const P3 = inv({ total: 105_000, issueDate: at("2026-10-28"), enrolment: part(50_000), proformaUntil: UNTIL, payments: [pay(50_000, "2026-10-28", { number: "TI-00003", taxMinor: 2_381, issuedAt: "2026-10-28T11:00:00.000Z" }), pay(55_000, "2026-11-11")] });
// Approved while approval made one invoice: Q1 part paid (no pro-forma, no tax invoice), Q2 paid in full. Both with a quote.
const Q1 = inv({ total: 550_000, issueDate: at("2026-11-11"), approval: { state: "approved", at: at("2026-11-11T12:00:00.000Z") }, enrolment: part(250_000), quote: { id: QID1, number: "QT-00003" }, payments: [pay(250_000, "2026-11-11")] });
const Q2 = inv({ issueDate: at("2026-11-11"), approval: { state: "approved", at: at("2026-11-11T13:00:00.000Z") }, enrolment: part(225_000), quote: { id: QID2, number: "QT-00004" }, payments: [pay(225_000, "2026-11-11")] });
// Never a pro-forma and approved before: not this script's to change. One whose close never said. Another organization. A close still waiting, with its quote.
const OLD = inv({ issueDate: at("2026-10-15"), enrolment: part(100_000), payments: [pay(100_000, "2026-10-15")] });
const UNSAID = inv({ issueDate: at("2026-11-11"), approval: { state: "approved", at: at("2026-11-11T14:00:00.000Z") }, enrolment: {}, payments: [pay(100_000, "2026-11-11")] });
const OFFQ = inv({ organizationId: OFF, issueDate: at("2026-11-11"), approval: { state: "approved", at: at("2026-11-11T12:00:00.000Z") }, enrolment: part(100_000), payments: [pay(100_000, "2026-11-11")] });
const W1 = inv({ issueDate: at("2026-11-12"), status: "draft", approval: { state: "pending", submittedAt: at("2026-11-12") }, enrolment: part(100_000), quote: { id: QID3, number: "QT-00005" } });
// CS Portal course invoices raised on 12 Nov: C1 500 of 1,575, C2 paid in full.
const C1 = inv({ total: 157_500, issueDate: at("2026-11-12"), createdAt: at("2026-11-12T08:00:00.000Z"), approval: { state: "not_required" }, enrolment: null, external: { source: "tetra-course", externalId: "course-1", flags: [] }, payments: [pay(50_000, "2026-11-12")] });
const C2 = inv({ total: 157_500, issueDate: at("2026-11-12"), createdAt: at("2026-11-12T08:30:00.000Z"), approval: { state: "not_required" }, enrolment: null, external: { source: "tetra-course", externalId: "course-2", flags: [] }, payments: [pay(157_500, "2026-11-12")] });
await db.collection("invoices").insertMany([P1, P2, P3, Q1, Q2, OLD, UNSAID, OFFQ, W1, C1, C2] as any[]);

const quote = (o: Record<string, any>) => ({
  _id: new Types.ObjectId(), organizationId: ON, customerId: CUST, customerName: "Student", status: "sent", issueDate: at("2026-11-11"), expiryDate: at("2026-12-11"),
  currency: "AED", lineItems: [], subtotalMinor: 0, discountTotalMinor: 0, taxTotalMinor: 0, taxBreakdown: [], totalMinor: 225_000, taxInclusive: true, invoicedMinor: 0, notes: "", terms: "",
  createdAt: at("2026-11-11"), updatedAt: at("2026-11-11"), ...o,
});
const M1 = quote({ quoteNumber: "QT-00001", status: "sent", createdAt: at("2026-08-30") });
const M2 = quote({ quoteNumber: "QT-00002", status: "accepted", createdAt: at("2026-08-30") });
const E1 = quote({ _id: QID1, quoteNumber: "QT-00003", status: "accepted", totalMinor: 550_000, enrolment: { invoiceId: Q1._id, source: "crm", externalId: "close-4", deleted: false } });
const E2 = quote({ _id: QID2, quoteNumber: "QT-00004", status: "accepted", enrolment: { invoiceId: Q2._id, source: "crm", externalId: "close-5", deleted: false } });
const E3 = quote({ _id: QID3, quoteNumber: "QT-00005", status: "sent", enrolment: { invoiceId: W1._id, source: "crm", externalId: "close-9", deleted: false } });
await db.collection("quotations").insertMany([M1, M2, E1, E2, E3] as any[]);

// The quote backfill's own undo file knows when P1 and P3 began; not P2.
const dir = mkdtempSync(join(tmpdir(), "proforma-restore-e2e-"));
const marksFrom = join(dir, "enrolment-quotes-backfill-undo-2026-11-11T09-54-23-111Z.json");
writeFileSync(marksFrom, JSON.stringify({ at: UNTIL.toISOString(), waiting: [], proformas: [
  { invoiceId: String(P1._id), invoiceNumber: P1.invoiceNumber, proformaAt: "2026-10-20T08:00:00.000Z" },
  { invoiceId: String(P3._id), invoiceNumber: P3.invoiceNumber, proformaAt: "2026-10-28T07:00:00.000Z" },
] }));
const undoFile = join(dir, "proforma-restore-undo.json");

const get = (d: Record<string, any>) => db.collection("invoices").findOne({ _id: d._id as Types.ObjectId }) as Promise<any>;
const tisOf = (d: any) => (d.payments ?? []).map((p: any) => p.taxInvoice?.number ?? "-").join(",");
const seq = async () => (await db.collection("sequences").findOne({ organizationId: ON, key: "tax_invoice" }))?.next;
const vatOf = async (from: string, to: string) => (await getVATReport(String(ON), from, to)).outputTaxMinor;
const Q1_TAX = Math.round((250_000 * vat(550_000)) / 550_000), P2_TAX = Math.round((50_000 * vat(225_000)) / 225_000), C1_TAX = Math.round((50_000 * vat(157_500)) / 157_500);
const OCT_BEFORE = vat(550_000) + vat(225_000) + vat(105_000) + vat(225_000);                      // P1, P2, P3, OLD: each whole, on its own date
const OCT_AFTER = 9_524 + 5_357 + 2_381 + vat(225_000);                                           // the three tax invoices paid in October, and OLD
const NOV_AFTER = vat(225_000) + vat(225_000) + vat(157_500) + (vat(105_000) - 2_381) + Q1_TAX + P2_TAX + C1_TAX;   // Q2, UNSAID, C2 whole; then the new tax invoices

step("0. As it was left");
check("Sales → Pro-formas & TIs is empty though three invoices carry tax invoices", (await listProformasAndTaxInvoices(String(ON))).proformas.length === 0 && (await listProformasAndTaxInvoices(String(ON))).taxInvoices.length === 0);
check("October's VAT report counts the three whole, on their own dates", (await vatOf("2026-10-01", "2026-10-31")) === OCT_BEFORE, String(await vatOf("2026-10-01", "2026-10-31")));
check("the quote backfill's undo file is found in its folder", findQuoteBackfillUndo(dir) === marksFrom, String(findQuoteBackfillUndo(dir)));

step("1. The look");
const look = await restoreProformas({ write: false, marksFrom, undoFile });
const row = (d: any) => look.rows.find((r) => r.invoice === d.invoiceNumber);
check("code 3-1-1-4-3-3: marks, approved, course, new tax invoices, quotes, links", look.code === "3-1-1-4-3-3", look.code);
check("P1: its mark back, the day from the undo file, TI-00001 as it is", row(P1)?.group === "was a pro-forma" && row(P1)?.proformaAt === "2026-10-20T08:00:00.000Z" && row(P1)?.taxInvoices.map((t) => `${t.number}${t.fresh ? "*" : ""}:${t.taxMinor}`).join() === "TI-00001:9524", show(row(P1)));
check("P2: not in the file — the day of its first tax invoice; the 500 of 12 Nov gets TI-00006", row(P2)?.proformaAt === "2026-10-25T09:00:00.000Z" && row(P2)?.taxInvoices.map((t) => `${t.number}${t.fresh ? "*" : ""}:${t.taxMinor}`).join() === `TI-00002:5357,TI-00006*:${P2_TAX}`, show(row(P2)));
check("P3: the payment that cleared it gets TI-00004 with the rest of its VAT", row(P3)?.taxInvoices.map((t) => `${t.number}${t.fresh ? "*" : ""}:${t.taxMinor}`).join() === `TI-00003:2381,TI-00004*:${vat(105_000) - 2_381}`, show(row(P3)));
check("Q1: approved part paid as one invoice — a pro-forma from its approval, TI-00005", row(Q1)?.group === "approved as one invoice" && row(Q1)?.proformaAt === "2026-11-11T12:00:00.000Z" && row(Q1)?.taxInvoices.map((t) => `${t.number}${t.fresh ? "*" : ""}:${t.taxMinor}`).join() === `TI-00005*:${Q1_TAX}`, show(row(Q1)));
check("C1: the course invoice raised part paid — TI-00007", row(C1)?.group === "course invoice" && row(C1)?.taxInvoices.map((t) => `${t.number}${t.fresh ? "*" : ""}:${t.taxMinor}`).join() === `TI-00007*:${C1_TAX}`, show(row(C1)));
check("the close that never said what was collected: listed, left out", row(UNSAID)?.outcome === "left out", show(row(UNSAID)));
check("not listed: paid in full, approved before, the other organization, still waiting, the course paid in full", [Q2, OLD, OFFQ, W1, C2].every((d) => !row(d)), show(look.rows.map((r) => r.invoice)));
check("the three enrolment quotes, not the two made by hand; three invoices point at one", look.quotes.map((q) => `${q.quote}>${q.invoice}`).join() === `QT-00003>${Q1.invoiceNumber},QT-00004>${Q2.invoiceNumber},QT-00005>${W1.invoiceNumber}` && look.links === 3, show(look.quotes));
check("nothing written", !(await get(P1)).proforma && (await get(P1)).proformaUntil && tisOf(await get(P2)) === "TI-00002,-" && (await db.collection("quotations").countDocuments({})) === 5 && (await seq()) === 3 && !existsSync(undoFile));

step("2. A wrong --expect");
let refused = "";
try { await restoreProformas({ write: true, expect: "3-1-1-4-3-2", marksFrom, undoFile }); } catch (e) { refused = (e as Error).message; }
check("refused, and nothing written", /would be 3-1-1-4-3-3 now/.test(refused) && !(await get(P1)).proforma && (await seq()) === 3 && !existsSync(undoFile), refused);
try { refused = ""; await restoreProformas({ write: true, marksFrom, undoFile }); } catch (e) { refused = (e as Error).message; }
check("no --expect at all: refused too", /--expect \(none\)/.test(refused), refused);

step("3. --write");
const done = await restoreProformas({ write: true, expect: look.code, marksFrom, undoFile });
check("five invoices changed, one left out, the undo file written", done.rows.filter((r) => r.outcome === "changed").length === 5 && done.rows.filter((r) => r.outcome === "left out").length === 1 && done.undoFile === undoFile && existsSync(undoFile), show(done.rows.map((r) => `${r.invoice}:${r.outcome}`)));
let p1 = await get(P1), p2 = await get(P2), p3 = await get(P3), q1 = await get(Q1), c1 = await get(C1);
check("P1: a pro-forma since 20 Oct 08:00 again, proformaUntil gone, TI-00001 untouched", p1.proforma?.at?.toISOString() === "2026-10-20T08:00:00.000Z" && p1.proformaUntil === undefined && p1.payments[0].taxInvoice.number === "TI-00001" && p1.payments[0].taxInvoice.taxMinor === 9_524 && p1.payments[0].taxInvoice.issuedAt.toISOString() === "2026-10-20T10:00:00.000Z", show(p1.proforma));
check("P2: TI-00002 kept, the 500 now TI-00006 with its share", tisOf(p2) === "TI-00002,TI-00006" && p2.payments[1].taxInvoice.taxMinor === P2_TAX && p2.payments[1].taxInvoice.netMinor === 50_000 - P2_TAX && p2.proforma?.at?.toISOString() === "2026-10-25T09:00:00.000Z", show(p2.payments[1].taxInvoice));
check("P3: TI-00004 takes the rest — its tax invoices add up to the invoice's VAT", tisOf(p3) === "TI-00003,TI-00004" && p3.payments.reduce((s: number, p: any) => s + p.taxInvoice.taxMinor, 0) === vat(105_000), show(p3.payments.map((p: any) => p.taxInvoice)));
check("Q1: a pro-forma from the moment it was approved, TI-00005", q1.proforma?.at?.toISOString() === "2026-11-11T12:00:00.000Z" && tisOf(q1) === "TI-00005" && q1.payments[0].taxInvoice.taxMinor === Q1_TAX, show(q1.payments[0].taxInvoice));
check("C1: a pro-forma from the moment it was raised, TI-00007", c1.proforma?.at?.toISOString() === "2026-11-12T08:00:00.000Z" && tisOf(c1) === "TI-00007", show(c1.proforma));
check("the next number is TI-00008", (await seq()) === 7, String(await seq()));
for (const [name, d] of [["paid in full", Q2], ["approved before", OLD], ["the close that never said", UNSAID], ["the other organization", OFFQ], ["still waiting", W1], ["the course paid in full", C2]] as const) {
  const x = await get(d);
  check(`${name}: no pro-forma, no tax invoice`, !x.proforma && (x.payments ?? []).every((p: any) => !p.taxInvoice), show({ p: x.proforma, t: tisOf(x) }));
}
const left = await db.collection("quotations").find({}).sort({ quoteNumber: 1 }).toArray();
check("the enrolment quotes are gone, the two made by hand are there", left.map((q) => q.quoteNumber).join() === "QT-00001,QT-00002", show(left.map((q) => q.quoteNumber)));
check("no invoice points at a quote any more", (await db.collection("invoices").countDocuments({ "quote.id": { $exists: true } })) === 0);

step("4. What the application sees");
const page = await listProformasAndTaxInvoices(String(ON));
check("Sales → Pro-formas & TIs: the five pro-formas, the seven tax invoices", page.proformas.map((p) => p.invoiceNumber).sort().join() === [P1, P2, P3, Q1, C1].map((d) => d.invoiceNumber).sort().join()
  && page.taxInvoices.map((t) => t.number).sort().join() === "TI-00001,TI-00002,TI-00003,TI-00004,TI-00005,TI-00006,TI-00007", show(page.taxInvoices.map((t) => t.number)));
check("October's VAT: the three tax invoices paid in it, not the three invoices whole", (await vatOf("2026-10-01", "2026-10-31")) === OCT_AFTER, `${await vatOf("2026-10-01", "2026-10-31")} vs ${OCT_AFTER}`);
check("November's VAT: the new tax invoices by the day paid, beside the ordinary invoices", (await vatOf("2026-11-01", "2026-11-30")) === NOV_AFTER, `${await vatOf("2026-11-01", "2026-11-30")} vs ${NOV_AFTER}`);

step("5. A second run");
const again = await restoreProformas({ write: false, marksFrom });
check("nothing to do: 0-0-0-0-0-0, only the left-out one listed", again.code === "0-0-0-0-0-0" && again.rows.length === 1 && again.rows[0]!.outcome === "left out" && again.quotes.length === 0, show(again));

step("6. The undo file");
const undone = await undoRestoreProformas(undoFile);
p1 = await get(P1); p2 = await get(P2); p3 = await get(P3); q1 = await get(Q1); c1 = await get(C1);
check("counts: 3 marks, 2 made, 4 tax invoices, 3 quotes, 3 links", undone.marks === 3 && undone.made === 2 && undone.taxInvoices === 4 && undone.quotes === 3 && undone.links === 3, show(undone));
check("the marks off again, proformaUntil as it was", [p1, p2, p3].every((d) => !d.proforma && d.proformaUntil?.toISOString() === UNTIL.toISOString()), show([p1.proforma, p1.proformaUntil]));
check("the tax invoices it gave taken off, the earlier ones kept", tisOf(p1) === "TI-00001" && tisOf(p2) === "TI-00002,-" && tisOf(p3) === "TI-00003,-" && tisOf(q1) === "-" && tisOf(c1) === "-" && !q1.proforma && !c1.proforma, show([tisOf(p2), tisOf(p3), tisOf(q1)]));
const back = await db.collection("quotations").findOne({ _id: QID1 }) as any;
check("the quotes back whole, ids and dates as they were, and the links", (await db.collection("quotations").countDocuments({})) === 5 && String(back?.enrolment?.invoiceId) === String(Q1._id) && back?.issueDate instanceof Date
  && String((await get(Q1)).quote?.id) === String(QID1) && (await get(W1)).quote?.number === "QT-00005", show(back));
check("October's VAT as it was left", (await vatOf("2026-10-01", "2026-10-31")) === OCT_BEFORE);
check("the numbers it gave are not given back", (await seq()) === 7);

step("7. Done again, and the application carries on");
const look2 = await restoreProformas({ write: false, marksFrom });
check("the same to do, numbered on from TI-00008", look2.code === "3-1-1-4-3-3" && look2.rows.find((r) => r.invoice === P3.invoiceNumber)?.taxInvoices[1]?.number === "TI-00008", show(look2.rows.find((r) => r.invoice === P3.invoiceNumber)));
await restoreProformas({ write: true, expect: look2.code, marksFrom, undoFile: join(dir, "undo-2.json") });
const after = await recordPayment(String(ON), String(P1._id), { method: "bank_transfer", amountMinor: 100_000, paidOn: "2026-11-13", reference: "", notes: "", accountName: "", chargesMinor: 0 } as never);
const fresh = after.payments[1]?.taxInvoice;
check("a payment recorded on P1 through the app gets its tax invoice: TI-00012, 47.62 VAT", fresh?.number === "TI-00012" && fresh.taxMinor === Math.round((100_000 * vat(550_000)) / 550_000) && Boolean(after.proforma?.at), show(fresh));

await new Promise((res) => setTimeout(res, 800));
await mongoose.disconnect();
console.log(`\n${failures ? "\x1b[31m" : "\x1b[32m"}${checks - failures}/${checks} checks passed\x1b[0m`);
process.exit(failures ? 1 : 0);
