/**
 * Rupees carry no VAT (invoice/payment-tax-invoice.ts — the user, 2026-11-13: "INR payment doesn't have the VAT"),
 * against a scratch database.
 *
 * What it proves. New payments: an enrolment part paid in rupees is a pro-forma whose rupee payment's tax invoice
 * carries no VAT, and the dirhams paid after carry the VAT of their own amount only; paid in full in rupees, the
 * invoice carries no VAT and its total does not move; paid in full partly in rupees, each payment has its own
 * document; a payment recorded later by INR Transfer carries none, and follows its method when that is edited; an
 * invoice that is itself in rupees is taxed as it always was. CS Portal: a course payment typed in rupees keeps its
 * rupees and carries no VAT — its invoice made without any when it pays the course in full. The VAT report and All
 * tax documents agree, and the list tells the rupee documents apart with the rupees paid. Older payments:
 * scripts/inr-payments-no-vat.ts notes the rupees, takes the VAT off, leaves what one invoice cannot say, refuses a
 * wrong --expect, and its undo puts every document back exactly.
 *
 * Run through scripts/inr-no-vat-e2e.sh (throwaway mongod, no .env anywhere).
 */
import mongoose, { Types } from "mongoose";
import { rmSync } from "node:fs";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}
const { approveInvoice, recordPayment, updatePayment, getInvoice, invoiceListSummary } = await import("../modules/invoice/invoice.service");
const { getVATReport, getDailyReport, getDailyBreakdown } = await import("../modules/reports/reports.service");
const { listTaxDocuments, listProformasAndTaxInvoices } = await import("../modules/invoice/payment-tax-invoice");
const { invoiceQuerySchema, isRupeePayment, isVatFreePayment, paidCurrency, paidAmountMinor, paidInOtherCurrencies, paidRateText } = await import("@delta/shared");
const { recordCoursePayment, rupeesTyped } = await import("../modules/tetra-deposit/course-invoice");
const { TetraDepositModel } = await import("../modules/tetra-deposit/tetra-deposit.model");
const { correctRupeePayments, undoRupeeCorrection } = await import("./inr-payments-no-vat");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const show = (v: unknown) => JSON.stringify(v).slice(0, 700);
const settle = () => new Promise((res) => setTimeout(res, 800));

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();
const db = mongoose.connection.db!;
const invoices = db.collection("invoices");

const VAT5 = [{ label: "VAT 5%", code: "VAT", rate: 5, isDefault: true, appliesTo: "sales" }];
const ON = new Types.ObjectId(), RUPEE_ORG = new Types.ObjectId(), OLD = new Types.ObjectId(), ASHA = new Types.ObjectId();
const CUST = new Types.ObjectId(), CUST_R = new Types.ObjectId(), CUST_O = new Types.ObjectId();
// Through the model, for its defaults: CS Portal's course invoices are made by createInvoice.
const { Organization } = await import("../modules/organization/organization.model");
await Organization.create([
  { _id: ON, name: "Delta HQ", baseCurrency: "AED", taxRegistrationNumber: "100000000000003", vatOnPayments: true, taxRates: VAT5 },
  { _id: RUPEE_ORG, name: "Rupee books", baseCurrency: "INR", vatOnPayments: true, taxRates: VAT5 },
  { _id: OLD, name: "Before the rule", baseCurrency: "AED", vatOnPayments: true, taxRates: VAT5 },
] as never);
await db.collection("users").insertOne({ _id: ASHA, name: "Asha Accountant", email: "asha@e2e.local", passwordHash: "x", status: "active", memberships: [{ organizationId: ON, roleId: new Types.ObjectId(), status: "active" }] });
await db.collection("customers").insertMany([
  { _id: CUST, organizationId: ON, customerCode: "CUST-90001", name: "Student", email: "s@e2e.local", phone: "+971500000000" },
  { _id: CUST_R, organizationId: RUPEE_ORG, customerCode: "CUST-90001", name: "Student", email: "s@e2e.local", phone: "+971500000000" },
  { _id: CUST_O, organizationId: OLD, customerCode: "CUST-90001", name: "Student", email: "s@e2e.local", phone: "+971500000000" },
]);
const vat = (g: number) => Math.round((g * 5) / 105);
const NOV = new Date("2026-11-11");
let n = 0;
const inv = (o: Record<string, any>) => {
  const total = o.total ?? 2_000_000;
  delete o.total;
  return {
    _id: new Types.ObjectId(), organizationId: ON, invoiceNumber: `EN-${String(++n).padStart(5, "0")}`, customerId: CUST, customerName: "Student", salespersonId: new Types.ObjectId(), salespersonName: "Rep",
    issueDate: NOV, dueDate: NOV, currency: "AED", exchangeRate: 1, taxInclusive: true, status: "draft",
    lineItems: [{ description: "Course 2", quantity: 1, unitPriceMinor: total, discountPct: 0, taxes: [{ code: "VAT", rate: 5, amountMinor: vat(total) }], lineSubtotalMinor: total - vat(total), discountMinor: 0, taxableMinor: total - vat(total), taxTotalMinor: vat(total), lineTotalMinor: total }],
    subtotalMinor: total - vat(total), discountTotalMinor: 0, taxBreakdown: [{ code: "VAT", rate: 5, amountMinor: vat(total) }], taxTotalMinor: vat(total), roundOffMinor: 0,
    totalMinor: total, baseTotalMinor: total, amountPaidMinor: 0, balanceMinor: total, approval: { state: "pending", submittedAt: NOV }, payments: [],
    external: { source: "crm", externalId: `close-${n}`, flags: [] }, createdAt: NOV, updatedAt: NOV,
    ...o, enrolment: { course: "Course 2", modeOfStudy: "online", language: "English", meetingBy: "Rep", ...(o.enrolment ?? {}) },
  };
};
const rupees = (aedMinor: number, paise: number) => ({ method: "inr_bank_account", amountMinor: aedMinor, paidOn: "2026-11-11", original: { currency: "INR", amountMinor: paise, rate: aedMinor / paise } });
const dirhams = (method: string, amountMinor: number) => ({ method, amountMinor, paidOn: "2026-11-11" });
const close = (...list: Array<{ amountMinor: number }>) => ({ declaredPaidMinor: list.reduce((s, p) => s + p.amountMinor, 0), declaredPaymentMethod: "cash", declaredPayments: list });

const A = inv({ enrolment: close(rupees(1_172_160, 30_000_000)) });
const B = inv({ enrolment: close(rupees(2_000_000, 45_500_000)) });
const C = inv({ enrolment: close(dirhams("cash", 1_000_000), rupees(1_000_000, 22_750_000)) });
const D = inv({ total: 1_200_000, enrolment: close(dirhams("cash", 1_200_000)) });
const E = inv({ total: 1_200_000, enrolment: close(dirhams("cash", 200_000)) });
const G = inv({ organizationId: RUPEE_ORG, customerId: CUST_R, currency: "INR", total: 5_000_000, enrolment: close(dirhams("inr_bank_account", 2_000_000)) });
await invoices.insertMany([A, B, C, D, E, G] as any[]);
const actor = { userId: String(ASHA), name: "Accountant" };
const scope = { all: true } as never;
const pay = (method: string, amountMinor: number, paidOn: string) => ({ method, amountMinor, paidOn, reference: "", notes: "", accountName: "", chargesMinor: 0 }) as never;
const raw = (id: unknown) => invoices.findOne({ _id: id as Types.ObjectId }) as Promise<any>;

step("1. Part paid in rupees at the close: a pro-forma, the rupees without VAT");
let a = await approveInvoice(String(ON), String(A._id), actor);
check("a pro-forma", Boolean(a.proforma?.at));
check("the rupee payment: no VAT, its tax invoice numbered, the whole amount net", a.payments[0]?.vatFree === true && Boolean(a.payments[0]?.taxInvoice?.number) && a.payments[0]!.taxInvoice!.taxMinor === 0 && a.payments[0]!.taxInvoice!.netMinor === 1_172_160, show(a.payments[0]));
check("the rupees it was paid in are kept on it: INR 300,000", a.payments[0]?.original?.currency === "INR" && a.payments[0]!.original!.amountMinor === 30_000_000, show(a.payments[0]?.original));
a = await recordPayment(String(ON), String(A._id), pay("bank_transfer", 827_840, "2026-11-20"));
check("the dirhams that clear it carry the VAT of their own 8,278.40 — 394.21, not the rupees' share too", a.status === "paid" && a.payments[1]?.taxInvoice?.taxMinor === 39_421 && a.payments[1]!.taxInvoice!.netMinor === 827_840 - 39_421 && !a.payments[1]?.vatFree, show(a.payments[1]?.taxInvoice));
check("…and the rupee tax invoice is still without", a.payments[0]?.taxInvoice?.taxMinor === 0 && a.payments[0]?.taxInvoice?.number === "TI-00001");

step("2. Paid in full in rupees at the close: the invoice carries no VAT");
const b = await approveInvoice(String(ON), String(B._id), actor);
check("not a pro-forma; no VAT on it; the total as it was", !b.proforma && b.taxTotalMinor === 0 && b.totalMinor === 2_000_000 && b.subtotalMinor === 2_000_000 && b.taxBreakdown.length === 0 && b.balanceMinor === 0 && b.status === "paid", show({ p: b.proforma, tax: b.taxTotalMinor, total: b.totalMinor, sub: b.subtotalMinor }));
check("its line untaxed, worth the same", b.lineItems[0]!.taxes.length === 0 && b.lineItems[0]!.taxTotalMinor === 0 && b.lineItems[0]!.lineTotalMinor === 2_000_000 && b.lineItems[0]!.taxableMinor === 2_000_000, show(b.lineItems[0]));
const bRaw = await raw(B._id);
check("what it had carried is kept: 952.38", bRaw.rupeesNoVat?.taxMinor === vat(2_000_000) && bRaw.rupeesNoVat.lineTaxes?.[0]?.[0]?.code === "VAT", show(bRaw.rupeesNoVat));
check("its payment marked, with its rupees, and no tax invoice of its own", b.payments[0]?.vatFree === true && b.payments[0]?.original?.amountMinor === 45_500_000 && !b.payments[0]?.taxInvoice);

step("3. Paid in full, partly in rupees: each payment its own document");
const c = await approveInvoice(String(ON), String(C._id), actor);
const cCash = c.payments.find((p) => p.method === "cash"), cInr = c.payments.find((p) => p.method === "inr_bank_account");
check("a pro-forma though nothing is owed", Boolean(c.proforma?.at) && c.balanceMinor === 0);
check("the cash: 476.19 on its 10,000; the rupees: none", cCash?.taxInvoice?.taxMinor === 47_619 && cInr?.taxInvoice?.taxMinor === 0 && cInr?.vatFree === true && !cCash?.vatFree, show([cCash?.taxInvoice, cInr?.taxInvoice]));

step("4. Paid in dirhams, as before");
const d = await approveInvoice(String(ON), String(D._id), actor);
check("paid in full in cash: the invoice is the tax invoice, its VAT whole", !d.proforma && d.taxTotalMinor === vat(1_200_000) && !d.payments[0]?.vatFree && !d.payments[0]?.taxInvoice);

step("5. A rupee payment recorded later, and its method edited");
let e = await approveInvoice(String(ON), String(E._id), actor);
check("part paid in cash: a pro-forma, 95.24 on the 2,000", Boolean(e.proforma?.at) && e.payments[0]?.taxInvoice?.taxMinor === 9_524);
e = await recordPayment(String(ON), String(E._id), pay("inr_bank_account", 300_000, "2026-11-15"));
check("3,000 by INR Transfer: no VAT, though its rupees were not given", e.payments[1]?.vatFree === true && e.payments[1]?.taxInvoice?.taxMinor === 0 && !e.payments[1]?.original && e.payments[0]?.taxInvoice?.taxMinor === 9_524, show(e.payments[1]));
e = await updatePayment(String(ON), String(E._id), e.payments[1]!.id, pay("card", 300_000, "2026-11-15"));
check("its method corrected to card: it carries VAT again (142.86), its number kept", !e.payments[1]?.vatFree && e.payments[1]?.taxInvoice?.taxMinor === 14_286 && e.payments[1]?.taxInvoice?.number === (await getInvoice(String(ON), String(E._id), scope)).payments[1]?.taxInvoice?.number, show(e.payments[1]?.taxInvoice));
e = await updatePayment(String(ON), String(E._id), e.payments[1]!.id, pay("inr_bank_account", 300_000, "2026-11-15"));
check("…and back to INR Transfer: none again", e.payments[1]?.vatFree === true && e.payments[1]?.taxInvoice?.taxMinor === 0);

step("6. An invoice that is itself in rupees");
const g = await approveInvoice(String(RUPEE_ORG), String(G._id), actor);
check("taxed as it always was: a pro-forma, its payment with its share of the tax", Boolean(g.proforma?.at) && !g.payments[0]?.vatFree && g.payments[0]?.taxInvoice?.taxMinor === Math.round((2_000_000 * vat(5_000_000)) / 5_000_000), show(g.payments[0]));

step("7. CS Portal course payments typed in rupees");
const student = (code: string) => ({ id: new Types.ObjectId().toString(), code, name: `Student ${code}`, email: `${code.toLowerCase()}@e2e.local`, level: "1", phone: "+971500000000" });
const request = async (o: Record<string, any>) => {
  const made = await TetraDepositModel.create({
    organizationId: ON, externalId: new Types.ObjectId().toString(), status: "approved", type: "BONUS", currency: "USD", requestedBy: "Cara CS", paymentMethod: "Bank Transfer",
    requestedAt: NOV, receivedAt: NOV, ...o,
    decision: { decidedById: ASHA, decidedByName: "Asha Accountant", decidedAt: NOV, approvedAmountMinor: o.amountMinor, transactionId: "", paymentMethod: "inr_bank_account", ...(o.decision ?? {}) },
  } as never);
  return TetraDepositModel.findById((made as any)._id).lean<any>();
};
const course = (kind: string, paidTodayAed: number, balanceAed: number) => ({ product: "DSLP", kind, withBonus: true, bonusUsd: 2500, paidTodayAed, balanceAed, paidBeforeAed: 0, price: 18370, priceCurrency: "AED", paidOn: "2026-11-11" });
const r1 = await request({ student: student("S1"), amountMinor: 319_390, amountOriginal: 300_000, amountCurrency: "INR", coursePayment: course("partial", 11_721.6, 8_278.4) });
check("recorded", (await recordCoursePayment(r1, { email: false })).ok === true);
const i1 = await invoices.findOne({ "payments.externalRef": `tetra:${r1.externalId}` }) as any;
check("part of the course in rupees: a pro-forma for 20,000, the payment's rupees kept (INR 300,000) and no VAT on it",
  Boolean(i1?.proforma?.at) && i1.totalMinor === 2_000_000 && i1.taxTotalMinor === vat(2_000_000) && i1.payments[0].vatFree === true && i1.payments[0].original?.amountMinor === 30_000_000
  && i1.payments[0].taxInvoice?.taxMinor === 0 && i1.payments[0].amountMinor === 1_172_160, show({ p: i1?.proforma, pay: i1?.payments?.[0] }));
const r2 = await request({ student: student("S2"), amountMinor: 326_975, amountOriginal: 307_000, amountCurrency: "INR", coursePayment: course("full", 12_000, 0) });
await recordCoursePayment(r2, { email: false });
const i2 = await invoices.findOne({ "payments.externalRef": `tetra:${r2.externalId}` }) as any;
check("the whole course in rupees: its invoice made without VAT, 12,000 as asked, paid", i2 && !i2.proforma && i2.taxTotalMinor === 0 && i2.totalMinor === 1_200_000 && i2.lineItems[0].taxes.length === 0 && i2.status === "paid" && Boolean(i2.rupeesNoVat?.at) && i2.payments[0].vatFree === true, show({ tax: i2?.taxTotalMinor, total: i2?.totalMinor, st: i2?.status }));
const r3 = await request({ student: student("S3"), amountMinor: 319_390, amountOriginal: 300_000, amountCurrency: "INR", coursePayment: course("partial", 11_721.6, 8_278.4), decision: { paymentMethod: "bank_transfer" } });
await recordCoursePayment(r3, { email: false });
const i3 = await invoices.findOne({ "payments.externalRef": `tetra:${r3.externalId}` }) as any;
check("typed in rupees but approved as a bank transfer: still rupees, still no VAT", i3?.payments[0].method === "bank_transfer" && i3.payments[0].vatFree === true && i3.payments[0].taxInvoice?.taxMinor === 0);
const r4 = await request({ student: student("S4"), amountMinor: 326_975, amountOriginal: 12_000, amountCurrency: "AED", coursePayment: course("full", 12_000, 0), decision: { paymentMethod: "card" } });
await recordCoursePayment(r4, { email: false });
const i4 = await invoices.findOne({ "payments.externalRef": `tetra:${r4.externalId}` }) as any;
check("typed in dirhams, paid by card: its VAT as before", i4?.taxTotalMinor === vat(1_200_000) && !i4.payments[0].vatFree && !i4.payments[0].original);
check("an accountant who approved another amount: the rupees typed no longer stand for it", rupeesTyped({ ...r1, decision: { approvedAmountMinor: 300_000 } }, 1_101_000) === undefined && rupeesTyped(r1, 1_172_160)?.amountMinor === 30_000_000);

step("8. The VAT report and All tax documents");
const report = await getVATReport(String(ON), "2026-11-01", "2026-11-30");
const expected = 39_421 + 0 + 47_619 + vat(1_200_000) + 9_524 + 0 + 0 + vat(1_200_000);
check("November: only the dirhams' VAT — nothing for any rupee payment", report.outputTaxMinor === expected, show({ got: report.outputTaxMinor, expected }));
const list = await listTaxDocuments(String(ON), { from: "2026-11-01", to: "2026-11-30", pageSize: 100 });
const t = list.totals.AED!;
check("the list comes to the same VAT", t.taxMinor === report.outputTaxMinor, show(t));
const rowOf = (invoiceId: unknown, kind: string, other: boolean) => list.rows.find((r) => r.invoiceId === String(invoiceId) && r.kind === kind && (r.foreignRecordedMinor > 0) === other)!;
const aInr = rowOf(A._id, "ti", true);
check("a rupee tax invoice: recorded as 11,721.60, paid as INR 300,000, no VAT", aInr.amountMinor === 1_172_160 && aInr.foreignRecordedMinor === 1_172_160 && aInr.foreign.length === 1 && aInr.foreign[0]!.currency === "INR" && aInr.foreign[0]!.amountMinor === 30_000_000 && aInr.taxMinor === 0 && aInr.foreignTaxMinor === 0 && aInr.feeMinor === 2_000_000, show(aInr));
check("…its enrolment's dirham payment is not a rupee document, and knows the enrolment was partly rupees", rowOf(A._id, "ti", false).foreign.length === 0 && rowOf(A._id, "ti", false).invForeignRecordedMinor === 1_172_160 && rowOf(A._id, "ti", false).invForeign[0]?.amountMinor === 30_000_000);
const bRow = rowOf(B._id, "invoice", true);
check("an invoice paid in full in rupees: all of it, INR 455,000, no VAT", bRow.foreignRecordedMinor === 2_000_000 && bRow.foreign[0]?.currency === "INR" && bRow.foreign[0]?.amountMinor === 45_500_000 && bRow.taxMinor === 0 && bRow.invForeignKnownMinor === 2_000_000, show(bRow));
const eInr = rowOf(E._id, "ti", true);
check("a rupee payment whose rupees were never given: a rupee document, the rupees unknown", eInr.foreignRecordedMinor === 300_000 && eInr.foreign[0]?.currency === "INR" && eInr.foreign[0]?.amountMinor === 0 && eInr.invForeignKnownMinor === 0);
const rupeeAed = 1_172_160 + 2_000_000 + 1_000_000 + 300_000 + 1_172_160 + 1_200_000 + 1_172_160;
const inrLine = t.foreign.find((f) => f.currency === "INR")!;
check("the totals count the rupee documents on their own: seven, their rupees, what they were recorded as, no VAT on them — and the one whose rupees are not known",
  t.foreign.length === 1 && inrLine.count === 7 && t.foreignRecordedMinor === rupeeAed && inrLine.amountMinor === 30_000_000 + 45_500_000 + 22_750_000 + 0 + 30_000_000 + 30_700_000 + 30_000_000
  && inrLine.recordedMinor === rupeeAed - 300_000 && inrLine.unknownCount === 1 && inrLine.unknownMinor === 300_000 && t.foreignTaxMinor === 0 && inrLine.taxMinor === 0, show(t));
const onlyInr = await listTaxDocuments(String(ON), { paidIn: "INR", pageSize: 100 }), onlyAed = await listTaxDocuments(String(ON), { paidIn: "own", pageSize: 100 });
check("Paid in INR: those seven; paid in the invoice's own currency: the rest, with nothing else among them", onlyInr.total === 7 && onlyInr.rows.every((r) => r.foreignRecordedMinor > 0) && onlyAed.total === list.total - 7 && onlyAed.rows.every((r) => r.foreignRecordedMinor === 0) && (onlyAed.totals.AED?.foreign.length ?? 0) === 0
  && (await listTaxDocuments(String(ON), { paidIn: "other" })).total === 7 && (await listTaxDocuments(String(ON), { paidIn: "inr" })).total === 7 && (await listTaxDocuments(String(ON), { paidIn: "aed" })).total === list.total - 7,
  show({ inr: onlyInr.total, aed: onlyAed.total, all: list.total }));
check("the rupee books: an INR invoice's payment by INR Transfer is in its own currency", (await listTaxDocuments(String(RUPEE_ORG))).rows.every((r) => r.foreignRecordedMinor === 0));
check("nothing here needs the correction", (await correctRupeePayments({ write: false })).rows.length === 0, show((await correctRupeePayments({ write: false })).rows));

step("8b. Rupees as rupees, never converted: the Invoices cards, the Daily report, the other tabs");
// What was paid in this organization: 124,443.20 in all, of which six payments in rupees with their rupees recorded
// (recorded as 77,164.80) and one by INR Transfer whose rupees were never given (3,000).
const RUPEES = 30_000_000 + 45_500_000 + 22_750_000 + 30_000_000 + 30_700_000 + 30_000_000, RECORDED = 1_172_160 + 2_000_000 + 1_000_000 + 1_172_160 + 1_200_000 + 1_172_160, PAID = 12_444_320;
check("the rule, said once for the API and the screens: the currency a payment was made in, its amount, and whether it carries VAT",
  isRupeePayment({ method: "inr_bank_account" }, "AED") && !isRupeePayment({ method: "inr_bank_account" }, "INR") && paidCurrency({ method: "card", original: { currency: "inr" } }, "AED") === "INR" && paidCurrency({ method: "card" }, "AED") === null
  && paidCurrency({ method: "bank_transfer", original: { currency: "usd", amountMinor: 5 } }, "AED") === "USD" && paidAmountMinor({ method: "bank_transfer", original: { currency: "USD", amountMinor: 5 } }, "AED") === 5
  && paidCurrency({ method: "cash", original: { currency: "AED", amountMinor: 3 } }, "AED") === null && paidCurrency({ method: "cash", original: { currency: "AED", amountMinor: 3 } }, "INR") === "AED"
  && isVatFreePayment({ method: "bank_transfer", original: { currency: "USD" } }, "AED") && isVatFreePayment({ method: "inr_bank_account" }, "AED") && !isVatFreePayment({ method: "card" }, "AED") && !isVatFreePayment({ method: "cash", original: { currency: "AED" } }, "INR")
  && paidAmountMinor({ method: "inr_bank_account", bankCurrency: "INR", bankAmountMinor: 7 }, "AED") === 7 && paidAmountMinor({ method: "inr_bank_account" }, "AED") === 0 && paidAmountMinor({ method: "card", bankCurrency: "INR", bankAmountMinor: 7 }, "AED") === 0
  && JSON.stringify(paidInOtherCurrencies([{ method: "inr_bank_account", amountMinor: 10, original: { currency: "INR", amountMinor: 250 } }, { method: "inr_bank_account", amountMinor: 4 }, { method: "cash", amountMinor: 9 }, { method: "card", amountMinor: 20, original: { currency: "USD", amountMinor: 6 } }], "AED"))
    === JSON.stringify({ lines: [{ currency: "USD", amountMinor: 6, recordedMinor: 20 }, { currency: "INR", amountMinor: 250, recordedMinor: 10 }], recordedMinor: 30, unknownCount: 1, unknownMinor: 4 })
  && paidRateText("INR", 30_000_000, "AED", 1_172_160) === "1 AED = 25.594 INR" && paidRateText("USD", 100_000, "AED", 367_250) === "1 USD = 3.6725 AED" && paidRateText("USD", 0, "AED", 5) === "");
const cards = (await invoiceListSummary(String(ON), invoiceQuerySchema.parse({}), scope)).byCurrency.find((g) => g.currency === "AED")!;
const cardInr = cards.foreign?.find((f) => f.currency === "INR");
check("Invoices cards: the rupees paid on their own — six invoices — and what they were recorded as, to take out of Paid", cards.paidMinor === PAID && cards.foreign?.length === 1 && cardInr?.amountMinor === RUPEES && cardInr?.recordedMinor === RECORDED && cardInr?.count === 6, show(cards));
check("…the rupee payment with no rupees recorded is counted apart, and stays in Paid", cardInr?.unknownCount === 1 && cardInr?.unknownMinor === 300_000);
check("…the rupee books have none", !((await invoiceListSummary(String(RUPEE_ORG), invoiceQuerySchema.parse({}), scope)).byCurrency[0]?.foreign?.length));
const daily = await getDailyReport(String(ON), "2026-11-01", "2026-11-30");
const dInr = daily.byCurrency?.find((c) => c.currency === "INR"), dAed = daily.byCurrency?.find((c) => c.currency === "AED");
check("Daily report: what was paid in rupees is income in rupees, under INR", dInr?.incomeMinor === RUPEES && dInr?.netMinor === RUPEES && (daily.currencies ?? []).join(",") === "AED,INR", show(daily.byCurrency));
check("…and AED income is what was paid in dirhams, plus the one whose rupees are not known", daily.currency === "AED" && dAed?.incomeMinor === PAID - RECORDED && daily.totals.incomeMinor === PAID - RECORDED, show(dAed));
check("…with the note's figures: the rupees, what they were recorded as, and the one not recorded", daily.otherCurrencyIncome?.lines.length === 1 && daily.otherCurrencyIncome.lines[0]!.currency === "INR" && daily.otherCurrencyIncome.lines[0]!.amountMinor === RUPEES
  && daily.otherCurrencyIncome.lines[0]!.recordedMinor === RECORDED && daily.otherCurrencyIncome.notRecordedCount === 1 && daily.otherCurrencyIncome.notRecordedMinor === 300_000, show(daily.otherCurrencyIncome));
check("…revenue is as invoiced, untouched", dAed?.revenueMinor === 2_000_000 * 5 + 1_200_000 * 4 && (dInr?.revenueMinor ?? 0) === 0, show(dAed));
const inrDays = await getDailyReport(String(ON), "2026-11-01", "2026-11-30", undefined, "INR");
check("…switched to INR: its days in rupees", inrDays.currency === "INR" && inrDays.rows.reduce((t, r) => t + r.incomeMinor, 0) === RUPEES && inrDays.rows.some((r) => r.date === "2026-11-11"));
const bInr = await getDailyBreakdown(String(ON), "income", "2026-11-01", "2026-11-30", undefined, "INR"), bAed = await getDailyBreakdown(String(ON), "income", "2026-11-01", "2026-11-30");
check("where it came from: the six rupee payments in rupees, each saying what it was recorded as", bInr.currency === "INR" && bInr.count === 6 && bInr.totalMinor === RUPEES && bInr.records.every((r) => r.currency === "INR" && /recorded as AED/.test(r.detail)), show(bInr.records.map((r) => [r.amountMinor, r.detail])));
check("…the dirham breakdown has none of them, and adds up to the report", bAed.currency === "AED" && bAed.totalMinor === PAID - RECORDED && bAed.records.every((r) => !/recorded as/.test(r.detail)));
const tabs = await listProformasAndTaxInvoices(String(ON));
const aTi = tabs.taxInvoices.find((x) => x.number === "TI-00001")!, aPf = tabs.proformas.find((x) => x.id === String(A._id))!, ePf = tabs.proformas.find((x) => x.id === String(E._id))!;
check("Tax invoices tab: a rupee tax invoice says its rupees; a dirham one none", aTi.paidCurrency === "INR" && aTi.paidAmountMinor === 30_000_000 && tabs.taxInvoices.filter((x) => x.invoiceId === String(A._id) && !x.paidCurrency).every((x) => x.paidAmountMinor === 0));
check("…one whose rupees were never recorded is still said to be rupees", tabs.taxInvoices.some((x) => x.invoiceId === String(E._id) && x.paidCurrency === "INR" && x.paidAmountMinor === 0));
check("Pro-formas tab: the part of what is paid that was rupees", aPf.foreign[0]?.currency === "INR" && aPf.foreign[0]?.amountMinor === 30_000_000 && aPf.foreignRecordedMinor === 1_172_160 && ePf.foreign.length === 0 && ePf.foreignRecordedMinor === 0, show([aPf.foreign, ePf.foreign]));

step("9. Rupee payments from before the rule: the correction");
const old = (o: Record<string, any>) => ({ ...inv({ organizationId: OLD, customerId: CUST_O, approval: { state: "approved", at: NOV }, status: "paid", ...o }), invoiceNumber: `OLD-${String(++n).padStart(3, "0")}` });
const paid = (method: string, amountMinor: number, o: Record<string, any> = {}) => ({ _id: new Types.ObjectId(), method, amountMinor, paidOn: NOV, reference: "", notes: "", accountName: "", chargesMinor: 0, createdAt: NOV, updatedAt: NOV, ...o });
const ti = (number: string, amountMinor: number, taxMinor: number) => ({ taxInvoice: { number, netMinor: amountMinor - taxMinor, taxMinor, issuedAt: NOV } });
const REQ = new Types.ObjectId().toString();
await TetraDepositModel.collection.insertOne({ organizationId: OLD, externalId: REQ, status: "approved", type: "BONUS", currency: "USD", amountMinor: 319_390, amountOriginal: 300_000, amountCurrency: "INR", decision: { approvedAmountMinor: 319_390 }, student: { name: "Student" } } as never);
const P1 = old({ status: "partial", proforma: { at: NOV }, amountPaidMinor: 1_172_160, balanceMinor: 827_840, payments: [paid("inr_bank_account", 1_172_160, { externalRef: `tetra:${REQ}`, ...ti("TI-09001", 1_172_160, 55_817) })] });
const P2 = old({ total: 1_200_000, proforma: { at: NOV }, amountPaidMinor: 1_200_000, balanceMinor: 0, payments: [
  paid("inr_bank_account", 500_000, { bankCurrency: "INR", bankAmountMinor: 11_375_000, ...ti("TI-09002", 500_000, 23_810) }),
  paid("card", 700_000, ti("TI-09003", 700_000, vat(1_200_000) - 23_810)),
] });
const O1 = old({ amountPaidMinor: 2_000_000, balanceMinor: 0, payments: [paid("inr_bank_account", 2_000_000, { bankCurrency: "INR", bankAmountMinor: 45_500_000 })] });
const O2 = old({ total: 1_200_000, status: "partial", amountPaidMinor: 500_000, balanceMinor: 700_000, payments: [paid("inr_bank_account", 500_000)],
  enrolment: { declaredPayments: [{ method: "inr_bank_account", amountMinor: 500_000, paidOn: "2026-11-11", original: { currency: "INR", amountMinor: 11_375_000, rate: 500_000 / 11_375_000 } }] } });
const O3 = old({ total: 1_200_000, amountPaidMinor: 1_200_000, balanceMinor: 0, payments: [paid("cash", 600_000), paid("inr_bank_account", 600_000)] });
const O4 = old({ currency: "INR", total: 5_000_000, amountPaidMinor: 5_000_000, balanceMinor: 0, payments: [paid("inr_bank_account", 5_000_000)] });
const O5 = old({ status: "void", amountPaidMinor: 2_000_000, balanceMinor: 0, payments: [paid("inr_bank_account", 2_000_000)] });
const oldDocs = [P1, P2, O1, O2, O3, O4, O5];
await invoices.insertMany(oldDocs as any[]);
const snapshot = async () => mongoose.mongo.BSON.EJSON.stringify(await invoices.find({ organizationId: OLD }).sort({ invoiceNumber: 1 }).toArray());
const before = await snapshot();
const vatBefore = (await getVATReport(String(OLD), "2026-11-01", "2026-11-30")).outputTaxMinor;

const look = await correctRupeePayments({ write: false });
const byNo = (rows: typeof look.rows, d: { invoiceNumber: string }) => rows.find((r) => r.invoice === d.invoiceNumber);
check("the look: the five that have rupee payments in dirham invoices — not the rupee invoice, not the void one", look.rows.map((r) => r.invoice).sort().join(",") === [P1, P2, O1, O2, O3].map((x) => x.invoiceNumber).sort().join(","), show(look.rows.map((r) => [r.invoice, r.outcome, r.detail])));
check("its code: 4 rupee amounts to note, 2 tax invoices, 1 invoice's VAT, 2 left as they are", look.code === "4-2-1-2", look.code);
check("a pro-forma's rupee tax invoice: 558.17 → none", byNo(look.rows, P1)?.taxInvoices[0]?.beforeMinor === 55_817 && byNo(look.rows, P1)?.taxInvoices[0]?.afterMinor === 0);
check("an invoice partly in rupees, and one still owing: left, and said why", /only part of it was paid in another currency/.test(byNo(look.rows, O3)?.detail ?? "") && /not paid in full yet/.test(byNo(look.rows, O2)?.detail ?? "") && byNo(look.rows, O2)?.rupeesNoted === 1, show([byNo(look.rows, O2), byNo(look.rows, O3)]));
check("the look wrote nothing", (await snapshot()) === before);
let refused = "";
try { await correctRupeePayments({ write: true, expect: "9-9-9-9" }); } catch (err) { refused = (err as Error).message; }
check("a wrong --expect is refused and nothing is written", /is not what there is now \(4-2-1-2\)/.test(refused) && (await snapshot()) === before, refused);

const UNDO = `${process.env.TMPDIR ?? "/tmp"}/inr-no-vat-e2e-undo-${Date.now()}.json`;
const wrote = await correctRupeePayments({ write: true, expect: "4-2-1-2", undoFile: UNDO });
const p1 = await raw(P1._id), p2 = await raw(P2._id), o1 = await raw(O1._id), o2 = await raw(O2._id), o3 = await raw(O3._id);
check("written, with an undo file", wrote.undoFile === UNDO && wrote.rows.filter((r) => r.outcome === "changed").length === 4);
check("P1: the rupees from its CS Portal request (INR 300,000), marked, TI-09001 kept with no VAT", p1.payments[0].original?.amountMinor === 30_000_000 && p1.payments[0].vatFree === true && p1.payments[0].taxInvoice.number === "TI-09001" && p1.payments[0].taxInvoice.taxMinor === 0 && p1.payments[0].taxInvoice.netMinor === 1_172_160, show(p1.payments[0]));
check("P2: the rupees from the bank account; its card payment keeps the VAT of its own 7,000", p2.payments[0].original?.amountMinor === 11_375_000 && p2.payments[0].taxInvoice.taxMinor === 0 && p2.payments[1].taxInvoice.taxMinor === 33_333 && !p2.payments[1].vatFree, show(p2.payments.map((p: any) => p.taxInvoice)));
check("O1, paid in full in rupees: its VAT off, its total as it was, what it carried kept", o1.taxTotalMinor === 0 && o1.totalMinor === 2_000_000 && o1.subtotalMinor === 2_000_000 && o1.lineItems[0].taxes.length === 0 && o1.rupeesNoVat?.taxMinor === vat(2_000_000) && o1.payments[0].vatFree === true && o1.payments[0].original?.amountMinor === 45_500_000, show({ tax: o1.taxTotalMinor, total: o1.totalMinor }));
check("O2, still owing: its rupees noted from the close, its VAT untouched", o2.payments[0].original?.amountMinor === 11_375_000 && o2.taxTotalMinor === vat(1_200_000) && !o2.payments[0].vatFree);
check("O3, partly rupees: untouched", mongoose.mongo.BSON.EJSON.stringify(o3) === mongoose.mongo.BSON.EJSON.stringify(O3));
const vatAfter = (await getVATReport(String(OLD), "2026-11-01", "2026-11-30")).outputTaxMinor;
check("the VAT report is lower by exactly what came off: 558.17 + 238.10 + 952.38", vatBefore - vatAfter === 55_817 + 23_810 + vat(2_000_000), show({ vatBefore, vatAfter }));
const again = await correctRupeePayments({ write: false });
check("run again: nothing more to change — only the two left as they are", again.code === "0-0-0-2" && again.rows.every((r) => r.outcome === "left as it is"), show(again.rows.map((r) => [r.invoice, r.outcome])));

step("10. Undo, and rupees only");
const undone = await undoRupeeCorrection(UNDO);
check("every invoice exactly as it was before", undone === 4 && (await snapshot()) === before);
const onlyLook = await correctRupeePayments({ write: false, rupeesOnly: true });
check("rupees only: 4 amounts to note, no VAT touched", onlyLook.code === "4-0-0-0", onlyLook.code);
const UNDO2 = `${process.env.TMPDIR ?? "/tmp"}/inr-no-vat-e2e-undo2-${Date.now()}.json`;
await correctRupeePayments({ write: true, expect: "4-0-0-0", rupeesOnly: true, undoFile: UNDO2 });
const p1b = await raw(P1._id), o1b = await raw(O1._id);
check("…the rupees are on the payments, every VAT figure as it was", p1b.payments[0].original?.amountMinor === 30_000_000 && p1b.payments[0].taxInvoice.taxMinor === 55_817 && !p1b.payments[0].vatFree && o1b.taxTotalMinor === vat(2_000_000)
  && (await getVATReport(String(OLD), "2026-11-01", "2026-11-30")).outputTaxMinor === vatBefore);
const oldList = await listTaxDocuments(String(OLD), { paidIn: "INR", pageSize: 100 });
check("the list then shows those rupees, with the VAT they still carry", oldList.rows.some((r) => r.number === "TI-09001" && r.foreign[0]?.amountMinor === 30_000_000 && r.foreignTaxMinor === 55_817) && (oldList.totals.AED?.foreignTaxMinor ?? 0) > 0, show(oldList.totals));
for (const f of [UNDO, UNDO2]) rmSync(f, { force: true });

step("11. Any other currency: only the invoice's own carries VAT, and each is shown as it was paid");
const FX = new Types.ObjectId(), OLD_FX = new Types.ObjectId(), CUST_F = new Types.ObjectId();
await Organization.create([
  { _id: FX, name: "Other currencies", baseCurrency: "AED", vatOnPayments: true, taxRates: VAT5 },
  { _id: OLD_FX, name: "Dollars before the rule", baseCurrency: "AED", vatOnPayments: true, taxRates: VAT5 },
] as never);
await db.collection("customers").insertOne({ _id: CUST_F, organizationId: FX, customerCode: "CUST-90001", name: "Student", email: "s@e2e.local", phone: "+971500000000" });
const dollars = (aedMinor: number, cents: number) => ({ method: "bank_transfer", amountMinor: aedMinor, paidOn: "2026-11-11", original: { currency: "USD", amountMinor: cents, rate: aedMinor / cents } });
const fx = (o: Record<string, any>) => inv({ organizationId: FX, customerId: CUST_F, ...o });
// The example the rule was agreed on: a 20,000 fee paid INR 300,000 + USD 1,000 + 4,605.90 by card — VAT 219.33.
const U1 = fx({ enrolment: close(rupees(1_172_160, 30_000_000), dollars(367_250, 100_000)) });
const U2 = fx({ total: 734_500, enrolment: close(dollars(734_500, 200_000)) });
const U3 = fx({ total: 1_200_000, enrolment: close(dirhams("cash", 600_000), dollars(600_000, 163_376)) });
await invoices.insertMany([U1, U2, U3] as any[]);
let u1 = await approveInvoice(String(FX), String(U1._id), actor);
check("part paid in rupees and dollars: a pro-forma, neither payment with VAT, each keeping what was paid", Boolean(u1.proforma?.at) && u1.payments.length === 2 && u1.payments.every((p) => p.vatFree === true && p.taxInvoice?.taxMinor === 0)
  && u1.payments[1]?.original?.currency === "USD" && u1.payments[1]?.original?.amountMinor === 100_000, show(u1.payments.map((p) => [p.method, p.vatFree, p.taxInvoice?.taxMinor, p.original])));
u1 = await recordPayment(String(FX), String(U1._id), pay("card", 460_590, "2026-11-25"));
check("the 4,605.90 by card that clears it carries 219.33 — the VAT of the dirhams alone", u1.status === "paid" && u1.payments[2]?.taxInvoice?.taxMinor === 21_933 && !u1.payments[2]?.vatFree && u1.payments.reduce((s, p) => s + (p.taxInvoice?.taxMinor ?? 0), 0) === 21_933, show(u1.payments.map((p) => p.taxInvoice)));
const u2 = await approveInvoice(String(FX), String(U2._id), actor);
check("paid in full in dollars: no VAT on the invoice, its total as it was", !u2.proforma && u2.taxTotalMinor === 0 && u2.totalMinor === 734_500 && u2.payments[0]?.vatFree === true && u2.payments[0]?.original?.amountMinor === 200_000, show({ tax: u2.taxTotalMinor, total: u2.totalMinor }));
const u3 = await approveInvoice(String(FX), String(U3._id), actor);
check("paid in full, half in dollars: a pro-forma — the cash with its own 285.72, the dollars with none", Boolean(u3.proforma?.at) && u3.payments.find((p) => p.method === "cash")?.taxInvoice?.taxMinor === 28_572 && u3.payments.find((p) => p.method === "bank_transfer")?.taxInvoice?.taxMinor === 0, show(u3.payments.map((p) => p.taxInvoice)));
const fxVat = await getVATReport(String(FX), "2026-11-01", "2026-11-30");
const fxList = await listTaxDocuments(String(FX), { pageSize: 100 });
const ft = fxList.totals.AED!;
check("the VAT report: 219.33 + 285.72, and the list agrees", fxVat.outputTaxMinor === 21_933 + 28_572 && ft.taxMinor === fxVat.outputTaxMinor, show({ report: fxVat.outputTaxMinor, list: ft.taxMinor }));
check("the list's totals: each currency on its own — dollars (three documents), rupees (one) — never added together",
  ft.count === 6 && ft.foreign.map((f) => f.currency).join(",") === "USD,INR" && ft.foreign[0]!.count === 3 && ft.foreign[0]!.amountMinor === 100_000 + 200_000 + 163_376 && ft.foreign[0]!.recordedMinor === 367_250 + 734_500 + 600_000
  && ft.foreign[1]!.count === 1 && ft.foreign[1]!.amountMinor === 30_000_000 && ft.foreignRecordedMinor === 1_172_160 + 367_250 + 734_500 + 600_000 && ft.foreignTaxMinor === 0, show(ft));
const u1Usd = fxList.rows.find((r) => r.invoiceId === String(U1._id) && r.foreign[0]?.currency === "USD")!, u1Card = fxList.rows.find((r) => r.invoiceId === String(U1._id) && r.foreign.length === 0)!;
check("a dollar tax invoice: USD 1,000.00, recorded as 3,672.50, no VAT; the enrolment paid in two other currencies", u1Usd.foreign[0]!.amountMinor === 100_000 && u1Usd.foreignRecordedMinor === 367_250 && u1Usd.taxMinor === 0
  && u1Card.invForeign.map((f) => f.currency).sort().join(",") === "INR,USD" && u1Card.invForeignRecordedMinor === 1_539_410 && u1Card.taxMinor === 21_933, show([u1Usd.foreign, u1Card.invForeign]));
check("Paid in: one currency, any other, or the invoice's own", (await listTaxDocuments(String(FX), { paidIn: "USD" })).total === 3 && (await listTaxDocuments(String(FX), { paidIn: "INR" })).total === 1
  && (await listTaxDocuments(String(FX), { paidIn: "other" })).total === 4 && (await listTaxDocuments(String(FX), { paidIn: "own" })).total === 2);
const fxCards = (await invoiceListSummary(String(FX), invoiceQuerySchema.parse({}), scope)).byCurrency.find((g) => g.currency === "AED")!;
check("Invoices cards: a line for dollars and one for rupees", fxCards.paidMinor === 3_934_500 && fxCards.foreign?.map((f) => `${f.currency}:${f.amountMinor}:${f.recordedMinor}:${f.count}`).join(" ") === "USD:463376:1701750:3 INR:30000000:1172160:1", show(fxCards.foreign));
const fxDaily = await getDailyReport(String(FX), "2026-11-01", "2026-11-30");
const inCur = (c: string) => fxDaily.byCurrency?.find((x) => x.currency === c)?.incomeMinor ?? 0;
check("Daily report: dollars are income in dollars, rupees in rupees, and AED only what was paid in dirhams", inCur("USD") === 463_376 && inCur("INR") === 30_000_000 && inCur("AED") === 460_590 + 600_000 && fxDaily.currency === "AED"
  && fxDaily.otherCurrencyIncome?.lines.map((l) => l.currency).join(",") === "USD,INR", show(fxDaily.byCurrency));
const allIncome = await getDailyBreakdown(String(FX), "income", "2026-11-01", "2026-11-30", undefined, "ALL"), ownIncome = await getDailyBreakdown(String(FX), "income", "2026-11-01", "2026-11-30");
check("the day's records, every currency at once: six payments, each in what it was paid; without that, the dirhams alone",
  allIncome.records.length === 6 && allIncome.records.map((r) => r.currency).sort().join(",") === "AED,AED,INR,USD,USD,USD" && allIncome.currency === "AED" && allIncome.totalMinor === 1_060_590
  && ownIncome.records.length === 2 && ownIncome.records.every((r) => r.currency === "AED"), show(allIncome.records.map((r) => [r.currency, r.amountMinor])));
const fxTabs = await listProformasAndTaxInvoices(String(FX));
check("the other tabs: a dollar tax invoice says USD 1,000.00; the pro-forma says what was paid in each currency", fxTabs.taxInvoices.some((x) => x.paidCurrency === "USD" && x.paidAmountMinor === 100_000)
  && fxTabs.proformas.find((x) => x.id === String(U1._id))?.foreign.map((f) => `${f.currency}:${f.amountMinor}`).sort().join(" ") === "INR:30000000 USD:100000");

step("12. An invoice itself in rupees, part paid in dirhams: shown as paid, taxed as it always was");
const G2 = inv({ organizationId: RUPEE_ORG, customerId: CUST_R, currency: "INR", total: 5_000_000, enrolment: close({ method: "cash", amountMinor: 2_275_000, paidOn: "2026-11-11", original: { currency: "AED", amountMinor: 100_000, rate: 22.75 } } as never) });
await invoices.insertOne(G2 as any);
const g2 = await approveInvoice(String(RUPEE_ORG), String(G2._id), actor);
check("its payment carries its share of the tax and is not marked free of it", Boolean(g2.proforma?.at) && !g2.payments[0]?.vatFree && g2.payments[0]?.taxInvoice?.taxMinor === Math.round((2_275_000 * vat(5_000_000)) / 5_000_000) && g2.payments[0]?.original?.currency === "AED", show(g2.payments[0]));
const g2Row = (await listTaxDocuments(String(RUPEE_ORG))).rows.find((r) => r.invoiceId === String(G2._id))!;
check("…and the list shows the dirhams it was paid in: AED 1,000.00, recorded as INR 22,750", g2Row.foreign[0]?.currency === "AED" && g2Row.foreign[0]?.amountMinor === 100_000 && g2Row.foreignRecordedMinor === 2_275_000 && g2Row.taxMinor > 0, show(g2Row.foreign));

step("13. A dollar payment from before the rule: the correction");
const X1 = old({ organizationId: OLD_FX, status: "partial", proforma: { at: NOV }, amountPaidMinor: 367_250, balanceMinor: 1_632_750,
  payments: [paid("bank_transfer", 367_250, ti("TI-09101", 367_250, 17_488))],
  enrolment: { declaredPayments: [{ method: "bank_transfer", amountMinor: 367_250, paidOn: "2026-11-11", original: { currency: "USD", amountMinor: 100_000, rate: 3.6725 } }] } });
await invoices.insertOne(X1 as any);
const fxLook = await correctRupeePayments({ write: false });
const x1Look = fxLook.rows.find((r) => r.invoice === X1.invoiceNumber);
check("the look: its dollars to note from the close, and its tax invoice's 174.88 to take off", x1Look?.rupeesNoted === 1 && x1Look?.taxInvoices[0]?.beforeMinor === 17_488 && x1Look?.taxInvoices[0]?.afterMinor === 0, show(x1Look));
const UNDO3 = `${process.env.TMPDIR ?? "/tmp"}/inr-no-vat-e2e-undo3-${Date.now()}.json`;
await correctRupeePayments({ write: true, expect: fxLook.code, undoFile: UNDO3 });
const x1 = await raw(X1._id);
check("written: USD 1,000.00 on the payment, marked, TI-09101 kept with no VAT", x1.payments[0].original?.currency === "USD" && x1.payments[0].original?.amountMinor === 100_000 && x1.payments[0].vatFree === true && x1.payments[0].taxInvoice.number === "TI-09101" && x1.payments[0].taxInvoice.taxMinor === 0, show(x1.payments[0]));
check("…and nothing is left to change anywhere", (await correctRupeePayments({ write: false })).rows.every((r) => r.outcome === "left as it is"));
rmSync(UNDO3, { force: true });

await settle();
await mongoose.disconnect();
console.log(`\n${failures ? "\x1b[31m" : "\x1b[32m"}${checks - failures}/${checks} checks passed\x1b[0m`);
process.exit(failures ? 1 : 0);
