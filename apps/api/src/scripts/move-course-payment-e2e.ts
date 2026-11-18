/**
 * scripts/move-course-payment.ts against a scratch database: a client's second CS Portal course payment, which made
 * its own invoice, moved onto the invoice it pays towards — the same payment (rupees, rate, receipt number, request),
 * its bank line moved with it, the invoice it made voided, the request pointing at the right invoice and CS Portal
 * told; a reference corrected; the dry run and the refusals changing nothing; a second run changing nothing either.
 *
 * Run through scripts/move-course-payment-e2e.sh (throwaway mongod, no .env anywhere).
 */
import mongoose, { Types } from "mongoose";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}
const { Organization } = await import("../modules/organization/organization.model");
const { Invoice } = await import("../modules/invoice/invoice.model");
const { BankTransaction } = await import("../modules/banking/bank-transaction.model");
const { TetraDepositModel } = await import("../modules/tetra-deposit/tetra-deposit.model");
const { createBankAccount } = await import("../modules/banking/banking.service");
const { updateOrganization } = await import("../modules/organization/organization.service");
const { recordPayment } = await import("../modules/invoice/invoice.service");
const { moveCoursePayment, parseFixRef } = await import("./move-course-payment");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const j = (v: unknown) => JSON.stringify(v).slice(0, 500);
const refusal = async (p: Promise<unknown>) => p.then(() => "", (e: Error) => e.message);

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();
const db = mongoose.connection.db!;
const dir = mkdtempSync(`${tmpdir()}/move-course-payment-e2e-`);

const org = await Organization.create({ name: "Delta HQ E2E", baseCurrency: "AED" });
const ORG = String(org._id);
const yaroon = await createBankAccount(ORG, { accountName: "Yaroon", currency: "INR", accountType: "current", openingBalanceMinor: 0, openingDate: "2026-01-01" } as never);
await updateOrganization(ORG, { paymentAccounts: { inr_bank_account: yaroon.id } } as never);
const CUST = new Types.ObjectId(), OTHER = new Types.ObjectId();
await db.collection("customers").insertMany([
  { _id: CUST, organizationId: org._id, customerCode: "CUST-00001", name: "Client One", email: "one@e2e.local", phone: "+971500000000" },
  { _id: OTHER, organizationId: org._id, customerCode: "CUST-00002", name: "Client Two", email: "two@e2e.local", phone: "+971500000001" },
]);
let n = 0;
const invoice = (o: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(), organizationId: org._id, invoiceNumber: `IN-${String(++n).padStart(5, "0")}`, customerId: CUST, customerName: "Client One",
  salespersonId: new Types.ObjectId(), salespersonName: "CS", issueDate: new Date("2026-10-13"), dueDate: new Date("2026-10-13"), currency: "AED", exchangeRate: 1,
  taxInclusive: true, status: "sent", lineItems: [{ description: "DSLP Offer — course", quantity: 1, unitPriceMinor: 2_000_000, discountPct: 0, taxes: [], lineSubtotalMinor: 2_000_000, discountMinor: 0, taxableMinor: 2_000_000, taxTotalMinor: 0, lineTotalMinor: 2_000_000 }],
  subtotalMinor: 2_000_000, discountTotalMinor: 0, taxBreakdown: [], taxTotalMinor: 0, roundOffMinor: 0, totalMinor: 2_000_000, baseTotalMinor: 2_000_000,
  amountPaidMinor: 0, balanceMinor: 2_000_000, approval: { state: "not_required" }, payments: [], external: { source: "tetra-course", externalId: `x-${n}`, flags: [] },
  createdAt: new Date(), updatedAt: new Date(), ...o,
});
const A = invoice(), B = invoice({ issueDate: new Date("2026-11-12"), lineItems: [{ description: "DSLP — course", quantity: 1, unitPriceMinor: 2_000_000, discountPct: 0, taxes: [], lineSubtotalMinor: 2_000_000, discountMinor: 0, taxableMinor: 2_000_000, taxTotalMinor: 0, lineTotalMinor: 2_000_000 }] });
const C = invoice({ customerId: OTHER, customerName: "Client Two" });
await db.collection("invoices").insertMany([A, B, C] as any[]);
const rupees = (inr: number, rate: number) => ({ currency: "INR", amountMinor: inr, rate });
const pay = async (invoiceId: Types.ObjectId, amountMinor: number, paidOn: string, ref: string, ext: string, receipt: string, original: ReturnType<typeof rupees>) => {
  await recordPayment(ORG, String(invoiceId), { method: "inr_bank_account", amountMinor, paidOn, reference: ref, notes: "Course payment from CS Portal", accountName: "", chargesMinor: 0 } as never,
    undefined, { externalRef: ext, proofUrl: `https://files.e2e.test/${receipt}.png`, original });
  await Invoice.updateOne({ _id: invoiceId, "payments.externalRef": ext }, { $set: { "payments.$.receiptNumber": receipt } });
};
await pay(A._id, 1_283_000, "2026-10-13", "3", "tetra:first", "RCT-00042", rupees(33_593_000, 0.03819));
await pay(B._id, 656_087, "2026-11-12", "", "tetra:second", "RCT-00074", rupees(16_796_500, 0.039060935313904685));
await db.collection("tetradeposits").insertOne({
  organizationId: org._id, externalId: "second", type: "BONUS", status: "approved", amountMinor: 178_770, currency: "USD", events: [],
  courseInvoice: { invoiceId: B._id, invoiceNumber: B.invoiceNumber, paymentId: (await Invoice.findById(B._id).lean<any>()).payments[0]._id, receiptNumber: "RCT-00074", created: true, amountMinor: 656_087, currency: "AED" },
  decision: { approvedAmountMinor: 178_770, decidedByName: "super admin", decidedAt: new Date() },
});
const told: string[] = [];
const tell = async (id: string) => { told.push(id); return "CS Portal has it (stand-in)"; };
const load = (x: { _id: Types.ObjectId }) => Invoice.findById(x._id).lean<any>();
const lineFor = async (x: { _id: Types.ObjectId }) => BankTransaction.find({ "matches.referenceId": String(x._id) }).lean<any[]>();
const linesIn = () => BankTransaction.find({ accountId: new Types.ObjectId(yaroon.id) }).lean<any[]>();
const base = { from: B.invoiceNumber, to: A.invoiceNumber, receipt: "RCT-00074", tell, dir };

step("Before");
// As CS Portal's rupee payments are recorded: in Yaroon, waiting for the rupees received (no bank line yet).
const yaroonNote = (await load(B)).payments[0]?.bankNote ?? "";
check("two invoices for the one course, each with its own payment in Yaroon",
  (await load(A)).amountPaidMinor === 1_283_000 && (await load(B)).amountPaidMinor === 656_087 && String((await load(B)).payments[0]?.bankAccountId) === yaroon.id,
  j({ lines: (await linesIn()).map((l) => l.reference), pay: (await load(A)).payments.map((p: any) => ({ acc: p.bankAccountId, amt: p.bankAmountMinor, cur: p.bankCurrency, note: p.bankNote })) }));

step("Dry run and refusals: nothing changes");
const dry = await moveCoursePayment({ ...base, fixRef: parseFixRef("RCT-00042=262761388982"), write: false });
check("the dry run says what it would do — AED 19,390.87 paid, AED 609.13 left, the second invoice void",
  dry.lines.some((l) => /after: IN-00001 paid AED 19,390\.87, balance AED 609\.13/.test(l)) && dry.lines.some((l) => /RCT-00042's reference: "3" → "262761388982"/.test(l)), dry.lines.join("\n"));
check("…and changes nothing", (await load(B)).payments.length === 1 && (await load(B)).status !== "void" && (await load(A)).payments.length === 1 && !dry.backupFile);
check("another client's invoice: refused", /not the same client's/.test(await refusal(moveCoursePayment({ ...base, to: C.invoiceNumber, write: true }))));
check("a receipt on neither: refused", /on neither/.test(await refusal(moveCoursePayment({ ...base, receipt: "RCT-09999", write: true }))));
// Another client's payment already has the reference that would be typed.
await Invoice.updateOne({ _id: C._id }, { $set: { payments: [{ _id: new Types.ObjectId(), method: "card", amountMinor: 100, paidOn: new Date(), reference: "TAKEN-1" }] } });
const takenMsg = await refusal(moveCoursePayment({ ...base, fixRef: { receipt: "RCT-00042", reference: "taken-1" }, write: false }));
check("…a reference already on another payment is refused, saying where", /Reference taken-1 is already on IN-00003/.test(takenMsg), takenMsg);
check("--fix-ref written wrong: refused", (() => { try { parseFixRef("RCT-1"); return false; } catch { return true; } })());

step("--write");
const done = await moveCoursePayment({ ...base, fixRef: parseFixRef("RCT-00042=262761388982"), write: true });
const a = await load(A), b = await load(B);
const moved = a.payments.find((p: any) => p.externalRef === "tetra:second");
check("on the first invoice: the same payment — amount, method, day, rupees and rate, receipt number, proof",
  moved?.amountMinor === 656_087 && moved?.method === "inr_bank_account" && moved?.paidOn.toISOString().slice(0, 10) === "2026-11-12" && moved?.original?.amountMinor === 16_796_500
  && moved?.original?.rate === 0.039060935313904685 && moved?.receiptNumber === "RCT-00074" && moved?.proofUrl === "https://files.e2e.test/RCT-00074.png" && /moved from IN-00002/.test(moved?.notes ?? ""), j(moved));
check("the first invoice: AED 19,390.87 paid, AED 609.13 left, part paid, its due date as it was",
  a.amountPaidMinor === 1_939_087 && a.balanceMinor === 60_913 && a.status === "partial" && a.dueDate.toISOString().slice(0, 10) === "2026-10-13", j({ p: a.amountPaidMinor, b: a.balanceMinor, s: a.status, d: a.dueDate }));
check("the second invoice: no payment left, void", b.payments.length === 0 && b.status === "void", j({ p: b.payments.length, s: b.status }));
const lines = await linesIn();
check("Yaroon: the moved payment still in it, as it was (its note too) — no bank line made or lost",
  String(moved?.bankAccountId) === yaroon.id && moved?.bankCurrency === "INR" && (moved?.bankNote ?? "") === yaroonNote && lines.length === 0 && (await lineFor(B)).length === 0,
  j({ acc: moved?.bankAccountId, cur: moved?.bankCurrency, note: moved?.bankNote, lines: lines.length }));
const dep = await TetraDepositModel.findOne({ externalId: "second" }).lean<any>();
check("the CS Portal request points at the first invoice, its event says so, and CS Portal was told",
  dep?.courseInvoice?.invoiceNumber === A.invoiceNumber && String(dep?.courseInvoice?.paymentId) === String(moved?._id) && dep?.courseInvoice?.created === false
  && dep?.events?.some((e: any) => e.kind === "moved") && told.length === 1 && told[0] === String(dep?._id), j(dep?.courseInvoice));
check("the first payment's reference corrected", a.payments.find((p: any) => p.receiptNumber === "RCT-00042")?.reference === "262761388982");
check("a backup of both invoices and the request, as they were", !!done.backupFile && JSON.parse(await Bun.file(done.backupFile!).text()).from.payments.length === 1);

step("Run again");
const again = await moveCoursePayment({ ...base, fixRef: parseFixRef("RCT-00042=262761388982"), write: true });
const a2 = await load(A);
check("nothing recorded twice, nothing else changed", a2.payments.length === 2 && a2.amountPaidMinor === 1_939_087 && (await linesIn()).length === 0
  && again.lines.some((l) => /Already on IN-00001/.test(l)) && again.lines.some((l) => /already void/.test(l)), again.lines.join("\n"));

await mongoose.disconnect();
console.log(`\n${failures ? "\x1b[31m" : "\x1b[32m"}${checks - failures}/${checks} checks passed\x1b[0m`);
process.exit(failures ? 1 : 0);
