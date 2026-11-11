/**
 * VAT on payments received (invoice/payment-tax-invoice.ts — the user, 2026-11-01: "2,000 paid, VAT on the 2,000"),
 * against a scratch database.
 *
 * What it proves: with the setting on, an enrolment approved part paid becomes a pro-forma and the 2,000 taken at the
 * close gets TI-00001 with 95.24 VAT; a balance payment gets the next TI with its own share; editing it keeps its
 * number and follows the amount; deleting it keeps its TI as cancelled, and the number is not used again; the payment
 * that clears the invoice takes the VAT left, so the TIs add up to the invoice's VAT exactly; each TI is emailed; the
 * VAT report and Revenue's Invoiced view count the TIs by the day paid, and not the pro-forma; the PDFs draw. An
 * enrolment approved paid in full, and any in an organization with the setting off, are untouched.
 *
 * Since 2026-11-11 (quotation/enrolment-quote.ts) an approval no longer starts a pro-forma: an enrolment is a quote,
 * then one invoice with each payment recorded against it. What is proved here now is that a pro-forma from before
 * keeps working exactly as it did until the backfill makes it an ordinary invoice — so the part-paid one below starts
 * as a pro-forma already; scripts/enrolment-quote-e2e.sh proves no new one is made, and the conversion.
 *
 * Run through scripts/vat-on-payments-e2e.sh (throwaway mongod, no .env anywhere).
 */
import mongoose, { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}
const { approveInvoice, recordPayment, updatePayment, deletePayment, getInvoice } = await import("../modules/invoice/invoice.service");
const { getVATReport } = await import("../modules/reports/reports.service");
const { getRevenueAnalysis } = await import("../modules/reports/analysis.service");
const { invoicePdfBuffer, taxInvoiceView } = await import("@delta/shared");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const show = (v: unknown) => JSON.stringify(v).slice(0, 600);
const settle = () => new Promise((res) => setTimeout(res, 800));

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();
const db = mongoose.connection.db!;

const ON = new Types.ObjectId(), OFF = new Types.ObjectId(), CUST = new Types.ObjectId(), CUST2 = new Types.ObjectId();
await db.collection("organizations").insertMany([
  { _id: ON, name: "Delta HQ", baseCurrency: "AED", taxRegistrationNumber: "100000000000003", vatOnPayments: true },
  { _id: OFF, name: "Elsewhere", baseCurrency: "AED", taxRegistrationNumber: "100000000000004" },
]);
await db.collection("customers").insertMany([
  { _id: CUST, organizationId: ON, customerCode: "CUST-00001", name: "Student", email: "s@e2e.local", phone: "+971500000000" },
  { _id: CUST2, organizationId: OFF, customerCode: "CUST-00001", name: "Student", email: "s@e2e.local", phone: "+971500000000" },
]);
const vat = (g: number) => Math.round((g * 5) / 105);
let n = 0;
const inv = (o: Record<string, any>) => {
  const total = o.total ?? 550_000;
  delete o.total;
  return {
    _id: new Types.ObjectId(), organizationId: ON, invoiceNumber: `IN-${String(++n).padStart(5, "0")}`, customerId: CUST, customerName: "Student", salespersonId: new Types.ObjectId(), salespersonName: "Rep",
    issueDate: new Date("2026-10-20"), dueDate: new Date("2026-10-20"), currency: "AED", exchangeRate: 1, taxInclusive: true, status: "draft",
    lineItems: [{ description: "Course 2", quantity: 1, unitPriceMinor: total, discountPct: 0, taxes: [{ code: "VAT", rate: 5, amountMinor: vat(total) }], lineSubtotalMinor: total - vat(total), discountMinor: 0, taxableMinor: total - vat(total), taxTotalMinor: vat(total), lineTotalMinor: total }],
    subtotalMinor: total - vat(total), discountTotalMinor: 0, taxBreakdown: [{ code: "VAT", rate: 5, amountMinor: vat(total) }], taxTotalMinor: vat(total), roundOffMinor: 0,
    totalMinor: total, baseTotalMinor: total, amountPaidMinor: 0, balanceMinor: total, approval: { state: "pending", submittedAt: new Date("2026-10-20") }, payments: [],
    external: { source: "crm", externalId: `close-${n}`, flags: [] }, createdAt: new Date("2026-10-20"), updatedAt: new Date("2026-10-20"),
    ...o, enrolment: { course: "Course 2", modeOfStudy: "online", language: "English", meetingBy: "Rep", ...(o.enrolment ?? {}) },
  };
};
const PART = inv({ proforma: { at: new Date("2026-10-20") }, enrolment: { declaredPaidMinor: 200_000, declaredPaymentMethod: "card", declaredPayments: [{ method: "card", amountMinor: 200_000, paidOn: "2026-10-20" }] } });
const FULL = inv({ total: 210_000, enrolment: { declaredPaidMinor: 210_000, declaredPaymentMethod: "cash", declaredPayments: [{ method: "cash", amountMinor: 210_000, paidOn: "2026-10-21" }] } });
const ELSE = inv({ organizationId: OFF, customerId: CUST2, enrolment: { declaredPaidMinor: 200_000, declaredPaymentMethod: "card", declaredPayments: [{ method: "card", amountMinor: 200_000, paidOn: "2026-10-20" }] } });
await db.collection("invoices").insertMany([PART, FULL, ELSE] as any[]);
const actor = { userId: String(new Types.ObjectId()), name: "Accountant" };
const scope = { all: true } as never;
const pay = (amountMinor: number, paidOn: string) => ({ method: "bank_transfer", amountMinor, paidOn, reference: "", notes: "", accountName: "", chargesMinor: 0 }) as never;
const TAX = vat(550_000);

step("1. A pro-forma from before, approved part paid — the close's payment its own tax invoice");
let d = await approveInvoice(String(ON), String(PART._id), actor);
check("a pro-forma", Boolean(d.proforma?.at), show(d.proforma));
const ti1 = d.payments[0]?.taxInvoice;
check("the 2,000 at the close: TI-00001, 95.24 VAT, 1,904.76 net", ti1?.number === "TI-00001" && ti1.taxMinor === 9_524 && ti1.netMinor === 190_476, show(ti1));
check("the invoice itself unchanged: 5,500, its VAT, 3,500 owing", d.totalMinor === 550_000 && d.taxTotalMinor === TAX && d.balanceMinor === 350_000 && d.status === "partial");

step("2. Paid in full at the close, and the setting off — as before");
const full = await approveInvoice(String(ON), String(FULL._id), actor);
check("paid in full: not a pro-forma, no tax invoice on the payment", !full.proforma && !full.payments[0]?.taxInvoice, show({ p: full.proforma, t: full.payments[0] }));
const off = await approveInvoice(String(OFF), String(ELSE._id), actor);
check("setting off: not a pro-forma, no tax invoice", !off.proforma && !off.payments[0]?.taxInvoice, show(off.proforma));
const offAfter = await recordPayment(String(OFF), String(ELSE._id), pay(100_000, "2026-11-10"));
check("…nor on a payment after", offAfter.payments.every((p) => !p.taxInvoice));

step("3. A balance payment, edited, deleted");
d = await recordPayment(String(ON), String(PART._id), pay(150_000, "2026-11-10"));
let ti2 = d.payments[1]?.taxInvoice;
check("1,500: TI-00002, 71.43 VAT", ti2?.number === "TI-00002" && ti2.taxMinor === 7_143 && ti2.netMinor === 142_857, show(ti2));
d = await updatePayment(String(ON), String(PART._id), d.payments[1]!.id, pay(100_000, "2026-11-10"));
ti2 = d.payments[1]?.taxInvoice;
check("edited to 1,000: still TI-00002, now 47.62 VAT", ti2?.number === "TI-00002" && ti2.taxMinor === 4_762 && ti2.netMinor === 95_238, show(ti2));
d = await deletePayment(String(ON), String(PART._id), d.payments[1]!.id);
check("deleted: TI-00002 kept as cancelled", d.payments.length === 1 && d.cancelledTaxInvoices?.length === 1 && d.cancelledTaxInvoices[0]!.number === "TI-00002" && d.cancelledTaxInvoices[0]!.amountMinor === 100_000, show(d.cancelledTaxInvoices));
d = await recordPayment(String(ON), String(PART._id), pay(150_000, "2026-11-12"));
check("the next payment: TI-00003 — the cancelled number not used again", d.payments[1]?.taxInvoice?.number === "TI-00003" && d.payments[1]?.taxInvoice?.taxMinor === 7_143, show(d.payments[1]?.taxInvoice));

step("4. The last payment takes what VAT is left");
d = await recordPayment(String(ON), String(PART._id), pay(200_000, "2026-12-05"));
const ti4 = d.payments[2]?.taxInvoice;
check("2,000 clearing it: TI-00004 with 95.23 — the rest of 261.90", ti4?.number === "TI-00004" && ti4.taxMinor === TAX - 9_524 - 7_143, show(ti4));
check("the TIs add up to the invoice's VAT and its total", d.payments.reduce((s, p) => s + (p.taxInvoice?.taxMinor ?? 0), 0) === TAX
  && d.payments.reduce((s, p) => s + (p.taxInvoice?.netMinor ?? 0) + (p.taxInvoice?.taxMinor ?? 0), 0) === 550_000 && d.status === "paid");
check("numbers kept on the earlier ones", d.payments.map((p) => p.taxInvoice?.number).join(",") === "TI-00001,TI-00003,TI-00004");

step("5. Emailed");
await settle();
const mails = await db.collection("emaillogs").find({ kind: "payment_tax_invoice" }).toArray();
check("one email per tax invoice issued (TI-00001 … TI-00004), the deleted one included", mails.length === 4 && ["TI-00001", "TI-00002", "TI-00003", "TI-00004"].every((x) => mails.some((m: any) => m.ref?.label === x)), show(mails.map((m: any) => [m.ref?.label, m.state])));
check("…none for the paid-in-full or the other organization", mails.every((m: any) => String(m.ref?.id) === String(PART._id)));

step("6. VAT report and Revenue, by the day paid");
const oct = await getVATReport(String(ON), "2026-10-01", "2026-10-31");
check("October: TI-00001's 95.24 + the paid-in-full invoice's VAT — not the pro-forma's 261.90", oct.outputTaxMinor === 9_524 + vat(210_000), show(oct));
const nov = await getVATReport(String(ON), "2026-11-01", "2026-11-30");
check("November: TI-00003's 71.43 (the deleted TI-00002 not counted)", nov.outputTaxMinor === 7_143 && nov.byRate.some((r) => r.code === "VAT" && r.outputMinor === 7_143), show(nov));
const dec = await getVATReport(String(ON), "2026-12-01", "2026-12-31");
check("December: TI-00004's 95.23", dec.outputTaxMinor === TAX - 9_524 - 7_143, show(dec));
const offOct = await getVATReport(String(OFF), "2026-10-01", "2026-10-31");
check("the other organization: the whole invoice's VAT in October, as before", offOct.outputTaxMinor === TAX, show(offOct));
const rv = await getRevenueAnalysis(String(ON), { from: "2026-11-01", to: "2026-11-30", basis: "invoiced", groupBy: "month", filters: {} });
check("Revenue, Invoiced, November: TI-00003's 1,500, collected", rv.records.map((r) => r.number).join(",") === "TI-00003" && rv.totals.invoicedMinor === 150_000 && rv.totals.collectedMinor === 150_000, show({ r: rv.records, t: rv.totals }));
const rvOct = await getRevenueAnalysis(String(ON), { from: "2026-10-01", to: "2026-10-31", basis: "invoiced", groupBy: "month", filters: {} });
check("…October: TI-00001's 2,000 and the paid-in-full invoice — not the pro-forma's 5,500", rvOct.records.map((r) => r.number).sort().join(",") === `${FULL.invoiceNumber},TI-00001` && rvOct.totals.invoicedMinor === 200_000 + 210_000, show(rvOct.records));

step("6b. Sales → Pro-formas & tax invoices");
const { listProformasAndTaxInvoices } = await import("../modules/invoice/payment-tax-invoice");
const pageNov = await listProformasAndTaxInvoices(String(ON), { from: "2026-11-01", to: "2026-11-30" });
check("November: the pro-forma (paid on in it) and TI-00003, the cancelled TI-00002 flagged; VAT 71.43",
  pageNov.proformas.map((p) => p.invoiceNumber).join(",") === PART.invoiceNumber
  && pageNov.taxInvoices.map((t) => `${t.number}${t.cancelled ? "x" : ""}`).sort().join(",") === "TI-00002x,TI-00003"
  && pageNov.totals.AED?.taxMinor === 7_143 && pageNov.totals.AED?.count === 1, show(pageNov));
const pageAll = await listProformasAndTaxInvoices(String(ON));
check("all time: every TI, newest first, adding up to the invoice's VAT", pageAll.taxInvoices.filter((t) => !t.cancelled).map((t) => t.number).join(",") === "TI-00004,TI-00003,TI-00001"
  && pageAll.totals.AED?.taxMinor === TAX && pageAll.proformas[0]!.taxInvoices.join(",") === "TI-00001,TI-00003,TI-00004", show(pageAll.taxInvoices));
const pageQ = await listProformasAndTaxInvoices(String(ON), { q: "TI-00003" });
check("search by a TI number finds it and its pro-forma", pageQ.taxInvoices.length === 1 && pageQ.proformas.length === 1, show(pageQ));
check("the other organization: none", (await listProformasAndTaxInvoices(String(OFF))).proformas.length === 0);

step("7. The documents");
const dto = await getInvoice(String(ON), String(PART._id), scope);
const proformaPdf = invoicePdfBuffer({ invoice: dto });
const tiPdf = invoicePdfBuffer({ invoice: taxInvoiceView(dto, dto.payments[0]!), taxInvoiceAgainst: dto.invoiceNumber });
check("the pro-forma and a tax invoice draw", proformaPdf.length > 1000 && tiPdf.length > 1000 && proformaPdf.subarray(0, 4).toString() === "%PDF");
if (process.env.VAT_E2E_PDF_DIR) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(`${process.env.VAT_E2E_PDF_DIR}/proforma.pdf`, proformaPdf);
  writeFileSync(`${process.env.VAT_E2E_PDF_DIR}/ti.pdf`, tiPdf);
}
const view = taxInvoiceView(dto, dto.payments[0]!);
check("the tax invoice: TI-00001, dated the day paid, one line of 2,000 with 95.24 VAT, paid", view.invoiceNumber === "TI-00001" && view.issueDate === "2026-10-20"
  && view.lineItems.length === 1 && view.totalMinor === 200_000 && view.taxTotalMinor === 9_524 && view.balanceMinor === 0 && /Course 2 \(IN-00001\)/.test(view.lineItems[0]!.description), show(view.lineItems));

await settle();
await mongoose.disconnect();
console.log(`\n${failures ? "\x1b[31m" : "\x1b[32m"}${checks - failures}/${checks} checks passed\x1b[0m`);
process.exit(failures ? 1 : 0);
