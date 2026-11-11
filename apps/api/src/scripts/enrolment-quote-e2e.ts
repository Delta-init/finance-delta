/**
 * An enrolment the Zoho Books way (quotation/enrolment-quote.ts — the user, 2026-11-11: "instead of pro-forma TIs we
 * need exact same as the quotation based system same as the Zoho Books have … and backfill current invoice also"),
 * against a scratch database.
 *
 * What it proves: a close from a CRM is a quote (QT-…) for the whole fee, waiting in Approvals; sent back it is a
 * draft, corrected it is out again with the corrected figures; approving it accepts the quote and converts it into ONE
 * invoice, numbered then, with the close's payments recorded against it — never a pro-forma, no TI, even with the old
 * "VAT on payments received" setting on; later payments go on the same invoice (partial → paid) and its VAT is counted
 * once, on the invoice's own date; a deleted or voided enrolment's quote is declined; an enrolment's quote cannot be
 * changed, sent, accepted, converted or deleted by hand, never reads as expired, and is hidden from someone who sees
 * only their own invoices; typed invoices and hand-made quotes work as before. Then the backfill: pro-formas become
 * ordinary invoices (their TIs kept as the payments' record, the VAT back on the invoice's date), closes still waiting
 * get a quote and keep their invoice number, approved invoices are left alone, a second run does nothing, and the undo
 * file puts it back.
 *
 * Run through scripts/enrolment-quote-e2e.sh (throwaway mongod, no .env anywhere).
 */
import mongoose, { Types } from "mongoose";
import { SYSTEM_ROLES, invoiceQuerySchema, quotationQuerySchema } from "@delta/shared";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}
const inv$ = await import("../modules/invoice/invoice.service");
const quo$ = await import("../modules/quotation/quotation.service");
const { intakeEnrolment } = await import("../modules/integrations/enrolment-intake.service");
const { getVATReport } = await import("../modules/reports/reports.service");
const { backfillEnrolmentQuotes, undoEnrolmentQuotesBackfill } = await import("../modules/quotation/enrolment-quotes-backfill");
const { listProformasAndTaxInvoices } = await import("../modules/invoice/payment-tax-invoice");
const { Organization } = await import("../modules/organization/organization.model");
const { Role } = await import("../modules/role/role.model");
const { User } = await import("../modules/user/user.model");
const { Item } = await import("../modules/inventory/item.model");
const { hashPassword } = await import("../lib/password");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const show = (v: unknown) => String(JSON.stringify(v)).slice(0, 500);
const settle = () => new Promise((res) => setTimeout(res, 600));
const refused = async (fn: () => Promise<unknown>) => { try { await fn(); return ""; } catch (e) { return (e as { code?: string; message?: string }).code ?? (e as Error).message ?? "error"; } };

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();
const db = mongoose.connection.db!;

// The old setting left ON: it must change nothing any more.
const org = await Organization.create({
  name: "Delta HQ", baseCurrency: "AED", taxRegistrationNumber: "100000000000003", vatOnPayments: true,
  taxRates: [{ label: "VAT 5%", code: "VAT", rate: 5, isDefault: true, appliesTo: "sales" }],
});
const ORG = String(org._id);
for (const def of SYSTEM_ROLES) {
  await Role.create({ organizationId: org._id, key: def.key, name: def.name, description: def.description, permissions: def.permissions, isSystem: true });
}
const roles = await Role.find({ organizationId: org._id }).lean();
const admin = await User.create({
  name: "Org Admin", email: "admin@e2e.local", passwordHash: await hashPassword("E2ePassword1!"), status: "active",
  memberships: [{ organizationId: org._id, roleId: new Types.ObjectId(String(roles.find((r) => r.key === "admin")!._id)), status: "active" }],
});
const item = await Item.create({ organizationId: org._id, itemNumber: "ITM-0001", name: "Course 2", sku: "C2", type: "service", trackStock: false, sellingPriceMinor: 550_000 });
const actor = { userId: String(admin._id), name: "Accountant" };
const all = { all: true } as never;
const quotes = () => db.collection("quotations");
const invoices = () => db.collection("invoices");
const quoteOf = (invoiceId: string) => quotes().findOne({ "enrolment.invoiceId": new Types.ObjectId(invoiceId) });
const pay = (amountMinor: number, paidOn: string) => ({ method: "bank_transfer", amountMinor, paidOn, reference: "", notes: "", accountName: "", chargesMinor: 0 }) as never;

const close = (externalId: string, o: { fee?: number; paid?: number; email?: string; on?: string } = {}) => {
  const paid = o.paid ?? 0;
  return intakeEnrolment(ORG, {
    externalId, source: "crm",
    customer: { name: "Student One", email: o.email ?? "one@e2e.local", phone: "+971500000001" },
    course: { name: "Course 2", itemId: String(item._id), amountMinor: o.fee ?? 550_000 },
    enrolledOn: o.on ?? "2026-10-20", declaredPaidMinor: paid,
    ...(paid ? { declaredPaymentMethod: "card", payments: [{ method: "card", amountMinor: paid, paidOn: o.on ?? "2026-10-20" }] } : {}),
    modeOfStudy: "online", language: "English",
  } as never);
};

step("1. A close from the CRM is a quote for the whole fee");
const a = await close("close-1", { paid: 200_000 });
let A = await inv$.getInvoice(ORG, a.invoiceId, all);
let qa = await quoteOf(a.invoiceId);
check("the CRM is answered with the quote's number (QT-00001)", a.invoiceNumber === "QT-00001", a.invoiceNumber);
check("a quote exists with that number, out (sent), for the whole fee", qa?.quoteNumber === "QT-00001" && qa.status === "sent" && qa.totalMinor === A.totalMinor && A.totalMinor > 0, show({ n: qa?.quoteNumber, s: qa?.status, t: qa?.totalMinor, i: A.totalMinor }));
check("…carrying which close it is, and the client", qa?.enrolment?.source === "crm" && qa.enrolment.externalId === "close-1" && String(qa.customerId) === String(A.customerId) && qa.lineItems.length === 1, show(qa?.enrolment));
check("the enrolment points at its quote, and waits for approval", A.quote?.number === "QT-00001" && A.quote.id === String(qa?._id) && A.approval?.state === "pending", show({ q: A.quote, a: A.approval?.state }));
check("nothing invoiced on the quote yet, and it is dated the day of the close", (qa?.invoicedMinor ?? 0) === 0 && !qa?.convertedTo && new Date(qa!.issueDate).toISOString().slice(0, 10) === "2026-10-20", String(qa?.issueDate));
const again = await close("close-1", { paid: 200_000 });
check("the same close sent again: the same quote, not a second one", again.duplicate === true && again.invoiceNumber === "QT-00001" && (await quotes().countDocuments({})) === 1, show(again));
let found = await inv$.listInvoices(ORG, invoiceQuerySchema.parse({ q: "QT-00001" }), all);
check("found in Invoices by the quote's number", found.data.length === 1 && found.data[0]!.id === a.invoiceId);

step("2. An enrolment's quote is not handled by hand");
const QA = String(qa!._id);
for (const [what, fn] of [
  ["changed", () => quo$.updateQuotation(ORG, QA, { notes: "x" } as never)],
  ["deleted", () => quo$.deleteQuotation(ORG, QA)],
  ["sent", () => quo$.sendQuotation(ORG, QA)],
  ["accepted", () => quo$.acceptQuotation(ORG, QA)],
  ["declined", () => quo$.declineQuotation(ORG, QA)],
  ["converted to a sales order", () => quo$.convertQuotation(ORG, QA, { target: "salesOrder" } as never)],
  ["converted to an invoice", () => quo$.convertToInvoice(ORG, QA, actor.userId, { mode: "full" } as never)],
] as [string, () => Promise<unknown>][]) {
  const r = await refused(fn);
  check(`cannot be ${what} from Quotations`, r === "CONFLICT", r);
}
await quotes().updateOne({ _id: qa!._id }, { $set: { expiryDate: new Date("2026-01-01") } });
const dto = await quo$.getQuotation(ORG, QA, { enrolments: true });
check("never reads as expired — it waits for finance, not the client", dto.status === "sent" && dto.enrolment?.invoiceId === a.invoiceId, show({ s: dto.status, e: dto.enrolment }));
const sentList = await quo$.listQuotations(ORG, quotationQuerySchema.parse({ status: "sent" }), { enrolments: true });
const expiredList = await quo$.listQuotations(ORG, quotationQuerySchema.parse({ status: "expired" }), { enrolments: true });
check("listed under Sent, not under Expired", sentList.data.some((x) => x.id === QA) && !expiredList.data.some((x) => x.id === QA));
const ownOnly = await quo$.listQuotations(ORG, quotationQuerySchema.parse({}), { enrolments: false });
check("hidden from someone who sees only their own invoices — list and by id", ownOnly.data.length === 0 && (await refused(() => quo$.getQuotation(ORG, QA, { enrolments: false }))) === "NOT_FOUND");

step("3. Sent back, corrected in the CRM, out again");
await inv$.returnInvoice(ORG, a.invoiceId, "Wrong fee", actor);
qa = await quoteOf(a.invoiceId);
check("sent back: the quote is a draft again", qa?.status === "draft", String(qa?.status));
const fixed = await close("close-1", { fee: 600_000, paid: 250_000 });
A = await inv$.getInvoice(ORG, a.invoiceId, all);
qa = await quoteOf(a.invoiceId);
check("corrected and resent: the same enrolment and quote number", fixed.invoiceId === a.invoiceId && fixed.invoiceNumber === "QT-00001" && A.invoiceNumber === "QT-00001", show(fixed));
check("the quote is out again with the corrected fee", qa?.status === "sent" && qa.totalMinor === A.totalMinor && A.totalMinor !== 0 && qa.lineItems[0]?.unitPriceMinor === A.lineItems[0]?.unitPriceMinor && (await quotes().countDocuments({})) === 1,
  show({ s: qa?.status, q: qa?.totalMinor, i: A.totalMinor }));
const TOTAL = A.totalMinor, TAX = A.taxTotalMinor;
check("(the corrected fee carries VAT)", TAX > 0 && TOTAL >= 600_000, show({ TOTAL, TAX }));

step("4. Approved: the quote becomes ONE invoice for the whole fee");
A = await inv$.approveInvoice(ORG, a.invoiceId, actor);
qa = await quoteOf(a.invoiceId);
check("the invoice gets its number now (IN-00001), no longer the quote's", /^IN-0*1$/.test(A.invoiceNumber), A.invoiceNumber);
check("the quote is accepted, invoiced in full, and points at that invoice", qa?.status === "accepted" && qa.invoicedMinor === TOTAL && String(qa.convertedTo?.invoiceId) === a.invoiceId && (qa.convertedTo?.invoiceIds ?? []).map(String).join() === a.invoiceId && Boolean(qa.acceptedAt),
  show({ s: qa?.status, i: qa?.invoicedMinor, c: qa?.convertedTo }));
check("the invoice remembers its quote", A.quote?.number === "QT-00001" && A.quote.id === QA, show(A.quote));
check("the invoice is for the whole fee, the close's 2,500 recorded against it: partially paid", A.totalMinor === TOTAL && A.payments.length === 1 && A.payments[0]!.amountMinor === 250_000 && A.amountPaidMinor === 250_000 && A.balanceMinor === TOTAL - 250_000 && A.status === "partial",
  show({ t: A.totalMinor, p: A.amountPaidMinor, b: A.balanceMinor, s: A.status }));
check("NOT a pro-forma, and the payment has no tax invoice — though the old setting is on", !A.proforma && !A.payments[0]!.taxInvoice && (await db.collection("sequences").countDocuments({ key: /tax_invoice/ })) === 0, show({ p: A.proforma, t: A.payments[0]!.taxInvoice }));
found = await inv$.listInvoices(ORG, invoiceQuerySchema.parse({ q: "QT-00001" }), all);
check("still found by the quote's number — what the CRM was given at the close", found.data.length === 1 && found.data[0]!.invoiceNumber === A.invoiceNumber);
check("approving it twice is refused, and changes nothing", (await refused(() => inv$.approveInvoice(ORG, a.invoiceId, actor))) === "CONFLICT" && (await inv$.getInvoice(ORG, a.invoiceId, all)).invoiceNumber === A.invoiceNumber);
check("the accepted quote still cannot be converted again by hand", (await refused(() => quo$.convertToInvoice(ORG, QA, actor.userId, { mode: "full" } as never))) === "CONFLICT");

step("5. Each later payment is recorded against the same invoice");
A = await inv$.recordPayment(ORG, a.invoiceId, pay(100_000, "2026-11-10"));
check("1,000 more: still the one invoice, partially paid, no tax invoice", A.payments.length === 2 && !A.payments[1]!.taxInvoice && A.status === "partial" && A.balanceMinor === TOTAL - 350_000, show({ s: A.status, b: A.balanceMinor }));
A = await inv$.recordPayment(ORG, a.invoiceId, pay(TOTAL - 350_000, "2026-12-05"));
check("the rest: paid", A.status === "paid" && A.balanceMinor === 0 && A.payments.length === 3 && A.payments.every((p) => !p.taxInvoice) && !A.proforma);
check("one invoice in the books for this enrolment", (await invoices().countDocuments({ "external.externalId": "close-1" })) === 1);
const oct = await getVATReport(ORG, "2026-10-01", "2026-10-31");
const nov = await getVATReport(ORG, "2026-11-01", "2026-11-30");
const dec = await getVATReport(ORG, "2026-12-01", "2026-12-31");
check("VAT: the whole invoice's, once, in the month it is dated — nothing in the months it was paid in", oct.outputTaxMinor === TAX && nov.outputTaxMinor === 0 && dec.outputTaxMinor === 0, show({ oct: oct.outputTaxMinor, nov: nov.outputTaxMinor, dec: dec.outputTaxMinor, TAX }));

step("6. Deleted or voided before or after: the quote follows");
const b = await close("close-2", { email: "two@e2e.local" });
check("the next close: QT-00002", b.invoiceNumber === "QT-00002", b.invoiceNumber);
await inv$.deleteInvoice(ORG, b.invoiceId);
let qb = await quotes().findOne({ quoteNumber: "QT-00002" });
check("deleted while waiting: the quote is declined and kept", qb?.status === "declined" && qb.enrolment?.deleted === true && !(await invoices().findOne({ _id: new Types.ObjectId(b.invoiceId) })), show({ s: qb?.status, e: qb?.enrolment }));
const c = await close("close-3", { email: "three@e2e.local" });
let C = await inv$.approveInvoice(ORG, c.invoiceId, actor);
check("a close with nothing paid, approved: QT-00003 → IN-00002, sent, unpaid", c.invoiceNumber === "QT-00003" && /^IN-0*2$/.test(C.invoiceNumber) && C.payments.length === 0 && C.balanceMinor === C.totalMinor, show({ q: c.invoiceNumber, i: C.invoiceNumber }));
await inv$.voidInvoice(ORG, c.invoiceId);
let qc = await quoteOf(c.invoiceId);
check("voided: its quote is declined, nothing invoiced on it", qc?.status === "declined" && (qc.invoicedMinor ?? 0) === 0 && !qc.convertedTo, show({ s: qc?.status, i: qc?.invoicedMinor }));
await inv$.restoreInvoice(ORG, c.invoiceId);
qc = await quoteOf(c.invoiceId);
check("restored: accepted and invoiced again", qc?.status === "accepted" && qc.invoicedMinor === C.totalMinor && String(qc.convertedTo?.invoiceId) === c.invoiceId, show({ s: qc?.status }));
const del = await refused(() => inv$.deleteInvoice(ORG, c.invoiceId));
qc = await quotes().findOne({ quoteNumber: "QT-00003" });
check("an approved enrolment with no payments can still be deleted — its own quote does not hold it", del === "" && qc?.status === "declined" && qc.enrolment?.deleted === true, del);

step("7. Typed invoices and hand-made quotes: as before");
const cust = await db.collection("customers").findOne({ email: "one@e2e.local" });
const typed = await inv$.createInvoice(ORG, {
  customerId: String(cust!._id), salespersonId: String(admin._id), issueDate: "2026-11-01", dueDate: "2026-11-15", currency: "AED",
  lineItems: [{ description: "Consulting", quantity: 1, unitPriceMinor: 100_000, taxes: [] }],
} as never, all);
check("an invoice typed here: an invoice number straight away, no quote", /^IN-0*3$/.test(typed.invoiceNumber) && !typed.quote && (await quotes().countDocuments({ "enrolment.invoiceId": new Types.ObjectId(typed.id) })) === 0, typed.invoiceNumber);
const manual = await quo$.createQuotation(ORG, {
  customerId: String(cust!._id), issueDate: "2026-11-01", expiryDate: "2099-01-01",
  lineItems: [{ description: "Workshop", quantity: 1, unitPriceMinor: 200_000, discountPct: 0, taxes: [] }],
} as never);
check("a quote made by hand takes the next quote number (QT-00004) — one sequence, no clash", manual.quoteNumber === "QT-00004" && !manual.enrolment, manual.quoteNumber);
await quo$.sendQuotation(ORG, manual.id);
await quo$.acceptQuotation(ORG, manual.id);
const conv = await quo$.convertToInvoice(ORG, manual.id, actor.userId, { mode: "full" } as never);
check("…and is sent, accepted and converted to an invoice by hand, as before", /^IN-/.test(conv.invoice.invoiceNumber) && conv.quotation.invoicedMinor === manual.totalMinor, show(conv.invoice));
const everyone = await quo$.listQuotations(ORG, quotationQuerySchema.parse({}), { enrolments: true });
const own = await quo$.listQuotations(ORG, quotationQuerySchema.parse({}), { enrolments: false });
check("Quotations: all four for accounts; only the hand-made one for an own-invoices reader", everyone.data.length === 4 && own.data.length === 1 && own.data[0]!.id === manual.id, show({ a: everyone.data.length, o: own.data.length }));

step("8. Backfill: what was there before");
// As the books were: a pro-forma with two TIs, two closes waiting (one sent back) under invoice numbers, one approved.
const vat = (g: number) => Math.round((g * 5) / 105);
let n = 100;
const old = (o: Record<string, any>) => {
  const total = 550_000;
  return {
    _id: new Types.ObjectId(), organizationId: org._id, invoiceNumber: `IN-${String(++n).padStart(5, "0")}`, customerId: cust!._id, customerName: "Student One", salespersonId: admin._id, salespersonName: "Rep",
    issueDate: new Date("2026-11-02"), dueDate: new Date("2026-11-02"), currency: "AED", exchangeRate: 1, taxInclusive: true, status: "draft",
    lineItems: [{ description: "Course 2", quantity: 1, unitPriceMinor: total, discountPct: 0, taxes: [{ code: "VAT", rate: 5, amountMinor: vat(total) }], lineSubtotalMinor: total - vat(total), discountMinor: 0, taxableMinor: total - vat(total), taxTotalMinor: vat(total), lineTotalMinor: total }],
    subtotalMinor: total - vat(total), discountTotalMinor: 0, taxBreakdown: [{ code: "VAT", rate: 5, amountMinor: vat(total) }], taxTotalMinor: vat(total), roundOffMinor: 0,
    totalMinor: total, baseTotalMinor: total, amountPaidMinor: 0, balanceMinor: total, approval: { state: "pending", submittedAt: new Date("2026-11-02") }, payments: [],
    external: { source: "crm", externalId: `old-${n}`, flags: [] }, createdAt: new Date("2026-11-02"), updatedAt: new Date("2026-11-02"),
    enrolment: { course: "Course 2", modeOfStudy: "online", language: "English", meetingBy: "Rep" },
    ...o,
  };
};
const PF = old({
  status: "partial", approval: { state: "approved", at: new Date("2026-11-02"), byName: "Accountant" }, proforma: { at: new Date("2026-11-02") },
  amountPaidMinor: 300_000, balanceMinor: 250_000,
  payments: [
    { _id: new Types.ObjectId(), method: "card", amountMinor: 200_000, paidOn: new Date("2026-11-02"), taxInvoice: { number: "TI-00001", netMinor: 190_476, taxMinor: 9_524, issuedAt: new Date("2026-11-02") } },
    { _id: new Types.ObjectId(), method: "cash", amountMinor: 100_000, paidOn: new Date("2026-12-03"), taxInvoice: { number: "TI-00002", netMinor: 95_238, taxMinor: 4_762, issuedAt: new Date("2026-12-03") } },
  ],
});
const WAIT = old({});
const BACK = old({ approval: { state: "returned", submittedAt: new Date("2026-11-02"), returnedReason: "Check the fee" } });
const DONE = old({ status: "sent", approval: { state: "approved", at: new Date("2026-11-02"), byName: "Accountant" } });
await invoices().insertMany([PF, WAIT, BACK, DONE] as any[]);
await db.collection("sequences").updateOne({ organizationId: org._id, key: "tax_invoice" }, { $set: { seq: 2 } }, { upsert: true });
const PFTAX = vat(550_000);
const novBefore = await getVATReport(ORG, "2026-11-01", "2026-11-30");
const decBefore = await getVATReport(ORG, "2026-12-01", "2026-12-31");
check("before: the pro-forma's VAT is counted payment by payment (95.24 in November besides the approved one's, 47.62 in December)", novBefore.outputTaxMinor === 9_524 + PFTAX && decBefore.outputTaxMinor === 4_762, show({ n: novBefore.outputTaxMinor, d: decBefore.outputTaxMinor }));

const look = await backfillEnrolmentQuotes({ write: false });
check("a look: 1 pro-forma and 2 waiting closes listed — the approved invoice and everything from today left out", look.proformas.length === 1 && look.proformas[0]!.invoiceNumber === PF.invoiceNumber && look.proformas[0]!.taxInvoices.join() === "TI-00001,TI-00002" && look.proformas[0]!.taxInvoicedMinor === 14_286
  && look.waiting.map((w) => w.invoiceNumber).sort().join() === [WAIT.invoiceNumber, BACK.invoiceNumber].sort().join(), show(look));
check("…and nothing changed by looking", Boolean((await invoices().findOne({ _id: PF._id }))?.proforma?.at) && (await quotes().countDocuments({})) === 4);

const done = await backfillEnrolmentQuotes({ write: true });
let pf = await inv$.getInvoice(ORG, String(PF._id), all);
check("written: the pro-forma is an ordinary invoice — same number, total, payments and balance", !pf.proforma && Boolean(pf.proformaUntil) && pf.invoiceNumber === PF.invoiceNumber && pf.totalMinor === 550_000 && pf.amountPaidMinor === 300_000 && pf.balanceMinor === 250_000 && ["partial", "overdue"].includes(pf.status),
  show({ p: pf.proforma, u: pf.proformaUntil, s: pf.status }));
check("its TI numbers stay on the payments, as the record of what was sent", pf.payments.map((p) => p.taxInvoice?.number).join() === "TI-00001,TI-00002");
const qw = await quoteOf(String(WAIT._id)), qr = await quoteOf(String(BACK._id));
check("the waiting close has its quote (sent), the sent-back one a draft — the next quote numbers", qw?.status === "sent" && qr?.status === "draft" && [qw.quoteNumber, qr.quoteNumber].sort().join() === "QT-00005,QT-00006" && qw.totalMinor === 550_000, show({ w: qw?.quoteNumber, r: qr?.quoteNumber }));
const wait = await inv$.getInvoice(ORG, String(WAIT._id), all);
check("they keep the invoice number given at the close, and point at their quote", wait.invoiceNumber === WAIT.invoiceNumber && wait.quote?.number === qw?.quoteNumber && done.waiting.every((w) => Boolean(w.quoteNumber)), show({ n: wait.invoiceNumber, q: wait.quote }));
check("the approved invoice is left as it is — no quote made up for it", !(await quoteOf(String(DONE._id))) && !(await invoices().findOne({ _id: DONE._id }))?.quote);
const novAfter = await getVATReport(ORG, "2026-11-01", "2026-11-30");
const decAfter = await getVATReport(ORG, "2026-12-01", "2026-12-31");
check("VAT after: the invoice's whole 261.90 on its own date (November), nothing in December", novAfter.outputTaxMinor === PFTAX + PFTAX && decAfter.outputTaxMinor === 0, show({ n: novAfter.outputTaxMinor, d: decAfter.outputTaxMinor }));
pf = await inv$.recordPayment(ORG, String(PF._id), pay(250_000, "2026-12-20"));
check("a payment on it now: recorded against the invoice, no new TI — paid", pf.status === "paid" && pf.payments.length === 3 && !pf.payments[2]!.taxInvoice && (await db.collection("sequences").findOne({ organizationId: org._id, key: "tax_invoice" }))?.seq === 2, show(pf.payments[2]));
const history = await listProformasAndTaxInvoices(ORG);
check("Past TIs still lists it — marked as an ordinary invoice now, its TIs out of the VAT figure", history.proformas.length === 1 && Boolean(history.proformas[0]!.convertedOn) && history.taxInvoices.length === 2 && history.taxInvoices.every((t) => t.converted) && !history.totals.AED, show({ p: history.proformas[0], t: history.totals }));
const approvedOld = await inv$.approveInvoice(ORG, String(WAIT._id), actor);
const qw2 = await quoteOf(String(WAIT._id));
check("the waiting close approved: keeps its invoice number, its quote accepted and invoiced", approvedOld.invoiceNumber === WAIT.invoiceNumber && qw2?.status === "accepted" && qw2.invoicedMinor === 550_000 && !approvedOld.proforma, show({ n: approvedOld.invoiceNumber, s: qw2?.status }));
const second = await backfillEnrolmentQuotes({ write: true });
check("run again: nothing left to do", second.proformas.length === 0 && second.waiting.length === 0, show(second));

step("9. Undo");
// (the payment recorded since is taken off first, as an accountant would — the undo is for straight after a run)
const undone = await undoEnrolmentQuotesBackfill(JSON.parse(JSON.stringify(done)));
check("the pro-forma is a pro-forma again; the sent-back close's quote is gone; the one approved since keeps its quote", undone.proformas === 1 && undone.quotes === 1 && undone.kept === 1
  && Boolean((await invoices().findOne({ _id: PF._id }))?.proforma?.at) && !(await invoices().findOne({ _id: PF._id }))?.proformaUntil
  && !(await quoteOf(String(BACK._id))) && !(await invoices().findOne({ _id: BACK._id }))?.quote && Boolean(await quoteOf(String(WAIT._id))), show(undone));
const redo = await backfillEnrolmentQuotes({ write: true });
check("and it can be run again after", redo.proformas.length === 1 && redo.waiting.length === 1 && redo.waiting[0]!.invoiceNumber === BACK.invoiceNumber && Boolean(redo.waiting[0]!.quoteNumber), show(redo));

await settle();
console.log(`\n${failures ? `\x1b[31m${failures} of ${checks} failed\x1b[0m` : `\x1b[32m${checks} passed\x1b[0m`}`);
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
