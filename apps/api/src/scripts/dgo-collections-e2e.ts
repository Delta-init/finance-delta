/**
 * POST /integrations/hrms/dgo-collections (2026-11-21) — HRMS's DGO Points budget asking for a month's eligible
 * collections — against a real API process and its signed-request guard:
 *
 *   Case 1  refusals: unsigned and wrongly signed (401), an HRMS organisation not linked (409, so HRMS doesn't read
 *           it as "finance needs updating"), a bad month and a month not started (422), errors in the usual shape;
 *   Case 2  October in Dubai: an AED payment with 5% VAT (reconciled), a Tabby DGO payment (VAT-free, unreconciled),
 *           a pro-forma payment with its own tax invoice, a USD zero-rated invoice's payment converted to AED
 *           (reconciled), a rupee payment on an AED invoice (VAT-free), the first and last Dubai minutes of the
 *           month (in) and the first of the next (out), a back-dated payment still waiting (left out, reported), a void
 *           and a draft invoice's payments and another organisation's (left out), credit notes (reported only);
 *   Case 3  nothing written: every invoice, credit note and bank line as it was.
 *
 * Run through scripts/dgo-collections-e2e.sh (throwaway mongod + API, no .env).
 */
import crypto from "node:crypto";
import mongoose, { Types } from "mongoose";
import { Organization } from "../modules/organization/organization.model";
import { Invoice } from "../modules/invoice/invoice.model";
import { CreditNote } from "../modules/credit-note/credit-note.model";
import { BankTransaction } from "../modules/banking/bank-transaction.model";
import { PayrollOrgLink } from "../modules/payroll-mapping/org-link.model";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\/[^/?]*e2e/.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}
const ORIGIN = `http://127.0.0.1:${process.env.E2E_API_PORT ?? "4161"}`;
const PATH = "/api/v1/integrations/hrms/dgo-collections";
const INBOUND_ID = process.env.INBOUND_CLIENT_ID ?? "";
const INBOUND_SECRET = process.env.INBOUND_INTEGRATION_SECRET ?? "";
if (!INBOUND_ID || !INBOUND_SECRET) {
  console.error("Refusing to run: INBOUND_CLIENT_ID and INBOUND_INTEGRATION_SECRET must be set");
  process.exit(1);
}

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const show = (v: unknown) => JSON.stringify(v).slice(0, 500);

type Res = { status: number; body: any };
async function post(payload: unknown, opts: { secret?: string; unsigned?: boolean } = {}): Promise<Res> {
  const raw = JSON.stringify(payload);
  const ts = String(Date.now());
  const nonce = crypto.randomUUID();
  const canonical = ["POST", PATH, ts, nonce, crypto.createHash("sha256").update(raw).digest("hex")].join("\n");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (!opts.unsigned) {
    headers["x-delta-client"] = INBOUND_ID;
    headers["x-delta-timestamp"] = ts;
    headers["x-delta-nonce"] = nonce;
    headers["x-delta-signature"] = crypto.createHmac("sha256", opts.secret ?? INBOUND_SECRET).update(canonical).digest("hex");
  }
  const r = await fetch(`${ORIGIN}${PATH}`, { method: "POST", headers, body: raw });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

const HRMS_ORG = new Types.ObjectId().toHexString();
const HRMS_UNLINKED = new Types.ObjectId().toHexString();
const MONTH = "2026-10";
const at = (iso: string) => new Date(iso);

let seq = 0;
const customerId = new Types.ObjectId(), salespersonId = new Types.ObjectId();
function invoice(orgId: Types.ObjectId, o: { currency?: string; exchangeRate?: number; totalMinor: number; taxTotalMinor: number; baseTotalMinor?: number; status?: string; proforma?: boolean; payments: Array<Record<string, unknown>> }) {
  seq++;
  return {
    organizationId: orgId,
    invoiceNumber: `INV-E2E-${String(seq).padStart(4, "0")}`,
    customerId, customerName: "Test Client",
    salespersonId, salespersonName: "Test Seller",
    status: o.status ?? "partial",
    issueDate: at("2026-10-01T08:00:00Z"),
    dueDate: at("2026-10-30T08:00:00Z"),
    currency: o.currency ?? "AED",
    exchangeRate: o.exchangeRate ?? 1,
    subtotalMinor: o.totalMinor - o.taxTotalMinor,
    taxTotalMinor: o.taxTotalMinor,
    totalMinor: o.totalMinor,
    baseTotalMinor: o.baseTotalMinor ?? o.totalMinor,
    amountPaidMinor: 0,
    balanceMinor: o.totalMinor,
    ...(o.proforma ? { proforma: { at: at("2026-10-01T08:00:00Z") } } : {}),
    payments: o.payments,
  };
}

async function snapshotOfData() {
  const [inv, cn, bt] = await Promise.all([
    Invoice.find({}).sort({ _id: 1 }).lean(),
    CreditNote.find({}).sort({ _id: 1 }).lean(),
    BankTransaction.collection.find({}).sort({ _id: 1 }).toArray(),
  ]);
  return crypto.createHash("sha256").update(JSON.stringify([inv, cn, bt])).digest("hex");
}

async function main() {
  await mongoose.connect(uri);
  if (mongoose.connection.host !== "127.0.0.1" || !/e2e/.test(mongoose.connection.db!.databaseName)) {
    console.error(`Refusing to run: connected to ${mongoose.connection.host}/${mongoose.connection.db!.databaseName}`);
    process.exit(1);
  }
  await mongoose.connection.db!.dropDatabase();

  step("Two organizations; the first linked to an HRMS organisation");
  const org = await Organization.create({ name: "Collections E2E HQ", baseCurrency: "AED" });
  const other = await Organization.create({ name: "Collections E2E Other", baseCurrency: "AED" });
  await PayrollOrgLink.create({ organizationId: org._id, hrmsOrgId: HRMS_ORG, hrmsOrgName: "HQ (HRMS)" });

  // Bank lines: one reconciled, one not.
  const lineRec = new Types.ObjectId(), lineRec2 = new Types.ObjectId(), lineOpen = new Types.ObjectId();
  await BankTransaction.collection.insertMany([
    { _id: lineRec, organizationId: org._id, accountId: new Types.ObjectId(), isReconciled: true, amountMinor: 525000, date: at("2026-10-05T00:00:00Z") },
    { _id: lineRec2, organizationId: org._id, accountId: new Types.ObjectId(), isReconciled: true, amountMinor: 367242, date: at("2026-10-07T00:00:00Z") },
    { _id: lineOpen, organizationId: org._id, accountId: new Types.ObjectId(), isReconciled: false, amountMinor: 210000, date: at("2026-10-06T00:00:00Z") },
  ]);

  const pay = (method: string, amountMinor: number, paidOn: string, extra: Record<string, unknown> = {}) => ({ method, amountMinor, paidOn: at(paidOn), ...extra });
  const docs = [
    // A: AED, 5% VAT inclusive: 10,500 total, 500 VAT. Pays 5,250 → VAT 250, net 5,000. Reconciled.
    invoice(org._id, { totalMinor: 1_050_000, taxTotalMinor: 50_000, payments: [pay("bank_transfer", 525_000, "2026-10-05T09:00:00Z", { bankTransactionId: lineRec })] }),
    // B: Tabby DGO carries no VAT, whatever the invoice's: 2,100 → net 2,100. Bank line not reconciled.
    invoice(org._id, { totalMinor: 210_000, taxTotalMinor: 10_000, payments: [pay("tabby_dgo", 210_000, "2026-10-06T09:00:00Z", { bankTransactionId: lineOpen })] }),
    // C: a pro-forma payment with its own tax invoice: 2,000 = 1,904.76 + 95.24.
    invoice(org._id, { totalMinor: 840_000, taxTotalMinor: 40_000, proforma: true, payments: [pay("card", 200_000, "2026-10-08T09:00:00Z", { taxInvoice: { number: "TI-E2E-1", netMinor: 190_476, taxMinor: 9_524 } })] }),
    // D: USD, zero-rated; exchangeRate 0.2723 USD per AED: 1,000 USD → 3,672.42 AED. Reconciled.
    invoice(org._id, { currency: "USD", exchangeRate: 0.2723, totalMinor: 300_000, taxTotalMinor: 0, baseTotalMinor: 1_101_726, payments: [pay("bank_transfer", 100_000, "2026-10-07T09:00:00Z", { bankTransactionId: lineRec2 })] }),
    // E: rupees on an AED invoice with VAT (no vatFree flag yet): VAT-free by isVatFreePayment → net 1,000.
    invoice(org._id, { totalMinor: 210_000, taxTotalMinor: 10_000, payments: [pay("bank_transfer", 100_000, "2026-10-09T09:00:00Z", { original: { currency: "INR", amountMinor: 2_500_000, rate: 0.04 } })] }),
    // F: the first Dubai minute of October (30 Sep 20:30 UTC) — in. 1,050 incl. 50 VAT → net 1,000.
    invoice(org._id, { totalMinor: 105_000, taxTotalMinor: 5_000, payments: [pay("cash", 105_000, "2026-09-30T20:30:00Z")] }),
    // G: 31 Oct 23:30 Dubai (19:30 UTC) — in; 1 Nov 00:30 Dubai (31 Oct 20:30 UTC) — out.
    invoice(org._id, { totalMinor: 210_000, taxTotalMinor: 10_000, payments: [pay("cash", 105_000, "2026-10-31T19:30:00Z"), pay("cash", 105_000, "2026-10-31T20:30:00Z")] }),
    // H: back-dated, still waiting for a manager: left out, reported (1,050 → net 1,000).
    invoice(org._id, { totalMinor: 105_000, taxTotalMinor: 5_000, payments: [pay("cash", 105_000, "2026-10-12T09:00:00Z", { lateEntry: { state: "pending", entryId: new Types.ObjectId(), reason: "Found the slip late", enteredByName: "Accountant" } })] }),
    // I: void invoice — out.
    invoice(org._id, { status: "void", totalMinor: 99_900, taxTotalMinor: 0, payments: [pay("cash", 99_900, "2026-10-10T09:00:00Z")] }),
    // J: draft invoice — out.
    invoice(org._id, { status: "draft", totalMinor: 88_800, taxTotalMinor: 0, payments: [pay("cash", 88_800, "2026-10-10T09:00:00Z")] }),
    // K: September — out.
    invoice(org._id, { totalMinor: 77_700, taxTotalMinor: 0, payments: [pay("cash", 77_700, "2026-09-15T09:00:00Z")] }),
    // L: another organization's October payment — out.
    invoice(other._id, { totalMinor: 66_600, taxTotalMinor: 0, payments: [pay("cash", 66_600, "2026-10-10T09:00:00Z")] }),
  ];
  const created = await Invoice.insertMany(docs);
  check("fixtures in: 12 invoices", created.length === 12);
  await CreditNote.insertMany([
    { organizationId: org._id, creditNoteNumber: "CN-E2E-1", invoiceId: created[0]!._id, invoiceNumber: created[0]!.invoiceNumber, customerId, customerName: "Test Client", reason: "Course change", status: "issued", totalMinor: 50_000, currency: "AED", issuedAt: at("2026-10-15T09:00:00Z") },
    { organizationId: org._id, creditNoteNumber: "CN-E2E-2", invoiceId: created[0]!._id, invoiceNumber: created[0]!.invoiceNumber, customerId, customerName: "Test Client", reason: "Never issued", status: "draft", totalMinor: 40_000, currency: "AED", issuedAt: at("2026-10-16T09:00:00Z") },
    { organizationId: org._id, creditNoteNumber: "CN-E2E-3", invoiceId: created[3]!._id, invoiceNumber: created[3]!.invoiceNumber, customerId, customerName: "Test Client", reason: "USD refund note", status: "applied", totalMinor: 10_000, currency: "USD", issuedAt: at("2026-10-20T09:00:00Z") },
    { organizationId: org._id, creditNoteNumber: "CN-E2E-4", invoiceId: created[0]!._id, invoiceNumber: created[0]!.invoiceNumber, customerId, customerName: "Test Client", reason: "November", status: "issued", totalMinor: 10_000, currency: "AED", issuedAt: at("2026-11-02T09:00:00Z") },
  ]);
  const before = await snapshotOfData();

  step("Case 1 — refusals");
  let r = await post({ hrmsOrgId: HRMS_ORG, month: MONTH }, { unsigned: true });
  check("unsigned: 401", r.status === 401, show(r));
  r = await post({ hrmsOrgId: HRMS_ORG, month: MONTH }, { secret: "not-the-secret-at-all-not-the-secret" });
  check("wrongly signed: 401", r.status === 401, show(r));
  r = await post({ hrmsOrgId: HRMS_UNLINKED, month: MONTH });
  check("an HRMS organisation not linked: 409 with the message, in the usual error shape",
    r.status === 409 && r.body?.error?.message === "This HRMS organisation isn't linked to a finance organisation", show(r));
  r = await post({ hrmsOrgId: HRMS_ORG, month: "2026-13" });
  check("a bad month: 422 'month is YYYY-MM'", r.status === 422 && /YYYY-MM/.test(r.body?.error?.message ?? ""), show(r));
  r = await post({ hrmsOrgId: HRMS_ORG, month: "2099-01" });
  check("a month not started: 422", r.status === 422 && /hasn't started/.test(r.body?.error?.message ?? ""), show(r));
  r = await post({ hrmsOrgId: "", month: MONTH });
  check("no HRMS organisation: 422", r.status === 422, show(r));

  step("Case 2 — October in Dubai");
  r = await post({ hrmsOrgId: HRMS_ORG, month: MONTH });
  const d = r.body?.data;
  check("200 with data", r.status === 200 && Boolean(d), show(r));
  check("the organization and its currency", d?.organization?.name === "Collections E2E HQ" && d?.currency === "AED" && d?.month === MONTH, show(d?.organization));
  check("7 payments counted (A, B, C, D, E, F, G's first)", d?.payments === 7, String(d?.payments));
  check("gross AED 16,122.42", d?.grossAed === 16122.42, String(d?.grossAed));
  check("VAT AED 445.24 (250 + 95.24 + 50 + 50; none on Tabby DGO, USD zero-rated or rupees)", d?.vatAed === 445.24, String(d?.vatAed));
  check("net AED 15,677.18", d?.netAed === 15677.18, String(d?.netAed));
  check("reconciled net AED 8,672.42 (A 5,000 + D 3,672.42)", d?.reconciledNetAed === 8672.42, String(d?.reconciledNetAed));
  check("not yet reconciled AED 7,004.76", d?.unreconciledNetAed === 7004.76, String(d?.unreconciledNetAed));
  check("the back-dated one waiting: 1, AED 1,000 — left out", d?.pendingLateEntries?.count === 1 && d?.pendingLateEntries?.netAed === 1000, show(d?.pendingLateEntries));
  const by = Object.fromEntries((d?.byMethod ?? []).map((m: any) => [m.method, m]));
  check("bank transfer: 3, AED 9,672.42", by.bank_transfer?.count === 3 && by.bank_transfer?.netAed === 9672.42, show(by.bank_transfer));
  check("Tabby DGO: 1, AED 2,100", by.tabby_dgo?.count === 1 && by.tabby_dgo?.netAed === 2100, show(by.tabby_dgo));
  check("cash: 2, AED 2,000 (first and last Dubai minute of the month)", by.cash?.count === 2 && by.cash?.netAed === 2000, show(by.cash));
  check("card: 1, AED 1,904.76 (the pro-forma's own tax invoice)", by.card?.count === 1 && by.card?.netAed === 1904.76, show(by.card));
  check("no other methods; largest first", (d?.byMethod ?? []).length === 4 && d.byMethod[0].method === "bank_transfer", show(d?.byMethod));
  check("credit notes for information: 2 (500 AED + 100 USD → 367.24 AED), not subtracted",
    d?.creditNotes?.count === 2 && d?.creditNotes?.totalAed === 867.24, show(d?.creditNotes));
  check("computedAt is a time", typeof d?.computedAt === "string" && !Number.isNaN(Date.parse(d.computedAt)));
  check("net = gross − VAT, reconciled + not = net", Math.abs(d.grossAed - d.vatAed - d.netAed) < 0.005 && Math.abs(d.reconciledNetAed + d.unreconciledNetAed - d.netAed) < 0.005);

  r = await post({ hrmsOrgId: HRMS_ORG, month: "2026-11" });
  check("November: only G's second payment (1 Nov 00:30 Dubai): net AED 1,000, its credit note", r.status === 200 && r.body?.data?.payments === 1 && r.body?.data?.netAed === 1000 && r.body?.data?.creditNotes?.count === 1, show(r.body?.data));
  r = await post({ hrmsOrgId: HRMS_ORG, month: "2026-09" });
  check("September: K only (F is October in Dubai): AED 777", r.status === 200 && r.body?.data?.payments === 1 && r.body?.data?.netAed === 777, show(r.body?.data));
  r = await post({ hrmsOrgId: HRMS_ORG, month: "2026-08" });
  check("a month with nothing: all zero", r.status === 200 && r.body?.data?.payments === 0 && r.body?.data?.netAed === 0 && r.body?.data?.byMethod?.length === 0, show(r.body?.data));

  step("Case 3 — read-only");
  check("every invoice, credit note and bank line as it was", (await snapshotOfData()) === before);

  console.log(`\n${failures ? "\x1b[31m" : "\x1b[32m"}${checks - failures} of ${checks} checks passed\x1b[0m`);
  await mongoose.disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
