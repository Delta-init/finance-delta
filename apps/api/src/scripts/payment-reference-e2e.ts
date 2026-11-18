/**
 * The payment reference (the user, 2026-11-18: "when we approve in finance we need to enter the payment reference … a
 * unique code … mandatory"), against a scratch database.
 *
 * What it proves:
 *   1. Approving a close asks each collected payment's reference: none for a card / Tabby / transfer payment is
 *      refused (it stays pending), the same one typed for two is refused, one already on another payment is refused
 *      whatever its case or spacing — saying which — and cash needs none. Approved, each payment carries its own.
 *      A script that approves without the list (no `references`) is not held.
 *   2. Recording a payment on the invoice screen: required unless cash, refused when another payment has it; a void
 *      invoice's payments don't hold theirs. Editing one: required, checked against the others only when it changes —
 *      two old payments that share one can still be corrected.
 *   3. A CRM balance payment: approved only with its reference, and its own; recorded with it.
 *   4. Money out: an expense marked paid or a purchase paid needs a reference unless cash (the expense's own counts);
 *      bills, payroll and commission payouts are refused without one by their routes' checks, and may repeat.
 *
 * Run through scripts/payment-reference-e2e.sh (throwaway mongod, no .env anywhere).
 */
import mongoose, { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}
const { approveInvoice, recordPayment, updatePayment } = await import("../modules/invoice/invoice.service");
const { Invoice } = await import("../modules/invoice/invoice.model");
const { Organization } = await import("../modules/organization/organization.model");
const { User } = await import("../modules/user/user.model");
const bp = await import("../modules/balance-payment/balance-payment.service");
const ex = await import("../modules/expense/expense.service");
const shared = await import("@delta/shared");
const { payRunSchema } = await import("../modules/payroll/payroll.schemas");

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

const org = await Organization.create({ name: "Delta HQ E2E", baseCurrency: "AED" });
const ORG = String(org._id);
const asha = await User.create({ name: "Asha Accountant", email: "asha@e2e-ref.test", passwordHash: "x", status: "active", memberships: [{ organizationId: org._id, roleId: new Types.ObjectId(), status: "active" }] });
const ASHA = String(asha._id);
const actor = { userId: ASHA, name: "Asha Accountant" };
const auth = { userId: ASHA, organizationId: ORG, role: "accountant", permissions: ["*"], isSuperAdmin: false };
const CUST = new Types.ObjectId();
await db.collection("customers").insertOne({ _id: CUST, organizationId: org._id, customerCode: "CUST-00001", name: "Student", email: "s@e2e-ref.test", phone: "+971500000000" });

let n = 0;
/** An invoice as it lands from a CRM close: `declared` the payments collected, waiting for approval unless said. */
const invoice = (o: { total?: number; declared?: { method: string; amountMinor: number }[]; status?: string; approval?: unknown; payments?: unknown[] } = {}) => {
  const total = o.total ?? 550_000;
  const vat = Math.round((total * 5) / 105);
  const paid = (o.payments as { amountMinor: number }[] | undefined)?.reduce((s, p) => s + p.amountMinor, 0) ?? 0;
  n++;
  return {
    _id: new Types.ObjectId(), organizationId: org._id, invoiceNumber: `IN-${String(n).padStart(5, "0")}`, customerId: CUST, customerName: "Student", salespersonId: new Types.ObjectId(), salespersonName: "Rep",
    issueDate: new Date("2026-11-10"), dueDate: new Date("2026-11-10"), currency: "AED", exchangeRate: 1, taxInclusive: true, status: o.status ?? "draft",
    lineItems: [{ description: "Course 1", quantity: 1, unitPriceMinor: total, discountPct: 0, taxes: [{ code: "VAT", rate: 5, amountMinor: vat }], lineSubtotalMinor: total - vat, discountMinor: 0, taxableMinor: total - vat, taxTotalMinor: vat, lineTotalMinor: total }],
    subtotalMinor: total - vat, discountTotalMinor: 0, taxBreakdown: [{ code: "VAT", rate: 5, amountMinor: vat }], taxTotalMinor: vat, roundOffMinor: 0,
    totalMinor: total, baseTotalMinor: total, amountPaidMinor: paid, balanceMinor: total - paid, approval: o.approval ?? { state: "pending", submittedAt: new Date("2026-11-10") },
    payments: o.payments ?? [],
    external: { source: "crm", externalId: `close-${n}`, flags: [] }, createdAt: new Date("2026-11-10"), updatedAt: new Date("2026-11-10"),
    enrolment: {
      course: "Course 1", modeOfStudy: "online", language: "English", meetingBy: "Rep",
      ...(o.declared ? { declaredPaidMinor: o.declared.reduce((s, p) => s + p.amountMinor, 0), declaredPaymentMethod: o.declared[0]!.method, declaredPayments: o.declared.map((p) => ({ ...p, paidOn: "2026-11-10" })) } : {}),
    },
  };
};
const legacyPayment = (reference: string, amountMinor = 10_000) => ({ _id: new Types.ObjectId(), method: "bank_transfer", amountMinor, paidOn: new Date("2026-09-01"), reference, notes: "", accountName: "", chargesMinor: 0 });
const A = invoice({ declared: [{ method: "tabby", amountMinor: 100_000 }, { method: "cash", amountMinor: 50_000 }] });
const B = invoice({ declared: [{ method: "card", amountMinor: 30_000 }, { method: "card", amountMinor: 20_000 }] });
const C = invoice({ declared: [{ method: "bank_transfer", amountMinor: 40_000 }] });
const D = invoice({ declared: [{ method: "bank_transfer", amountMinor: 40_000 }] });
const E = invoice({ declared: [{ method: "cash", amountMinor: 40_000 }] });
const OPEN = invoice({ status: "sent", approval: { state: "not_required" } });
const VOID = invoice({ status: "void", approval: { state: "not_required" }, payments: [legacyPayment("VOID-1")] });
// Two payments recorded before the rule with the same reference — they stay as they are.
const OLD1 = invoice({ status: "partial", approval: { state: "not_required" }, payments: [legacyPayment("LEGACY-1")] });
const OLD2 = invoice({ status: "partial", approval: { state: "not_required" }, payments: [legacyPayment("LEGACY-1")] });
await db.collection("invoices").insertMany([A, B, C, D, E, OPEN, VOID, OLD1, OLD2] as any[]);
const doc = (x: { _id: Types.ObjectId }) => Invoice.findById(x._id).lean<any>();
const id = (x: { _id: Types.ObjectId }) => String(x._id);

/* ── 1 ── */
step("1. Approving a close: each collected payment's reference");
let r = await refusal(approveInvoice(ORG, id(A), actor, { references: [] }));
check("none typed: refused, naming the payment", /Enter the reference of payment 1 \(tabby AED 1,000\.00\)/.test(r), r);
check("…the invoice still waits, nothing recorded", (await doc(A))?.approval?.state === "pending" && (await doc(A))?.payments?.length === 0);
r = await refusal(approveInvoice(ORG, id(B), actor, { references: ["AUTH 9", "auth9"] }));
check("the same one for two payments (case and spaces don't count): refused", /AUTH 9 is typed for two payments|auth9 is typed for two payments/.test(r), r);
const a = await approveInvoice(ORG, id(A), actor, { references: ["ORD-1", ""] });
const aPays = (await doc(A))?.payments ?? [];
check("Tabby with its reference, cash with none: approved, each payment carries its own",
  a.approval?.state === "approved" && aPays.length === 2 && aPays.some((p: any) => p.method === "tabby" && p.reference === "ORD-1") && aPays.some((p: any) => p.method === "cash" && p.reference === ""), j(aPays.map((p: any) => [p.method, p.reference])));
r = await refusal(approveInvoice(ORG, id(C), actor, { references: [" ord - 1 "] }));
check("one already on another payment, typed differently: refused, saying which", new RegExp(`already on ${A.invoiceNumber} — a payment of AED 1,000\\.00 on 2026-11-10`).test(r), r);
check("…still pending", (await doc(C))?.approval?.state === "pending");
r = await refusal(approveInvoice(ORG, id(C), actor, { references: ["VOID-1"] }));
check("a void invoice's payments don't hold theirs", r === "" && (await doc(C))?.payments?.[0]?.reference === "VOID-1", r);
r = await refusal(approveInvoice(ORG, id(D), actor));
check("a script approving without the list is not held", r === "" && (await doc(D))?.payments?.[0]?.reference === "", r);
r = await refusal(approveInvoice(ORG, id(E), actor, { references: [] }));
check("all cash: approved with none", r === "", r);

/* ── 2 ── */
step("2. Recording and editing a payment on the invoice");
const screen = { reference: true } as const;
const pay = (over: Record<string, unknown>) => ({ method: "bank_transfer", amountMinor: 10_000, paidOn: "2026-11-15", reference: "", notes: "", accountName: "", chargesMinor: 0, ...over }) as never;
r = await refusal(recordPayment(ORG, id(OPEN), pay({}), undefined, undefined, undefined, screen));
check("a transfer with no reference: refused", /Enter the payment reference/.test(r), r);
r = await refusal(recordPayment(ORG, id(OPEN), pay({ reference: "Ord-1" }), undefined, undefined, undefined, screen));
check("one already used: refused, saying which", new RegExp(`Reference Ord-1 is already on ${A.invoiceNumber}`).test(r), r);
r = await refusal(recordPayment(ORG, id(OPEN), pay({ method: "cash" }), undefined, undefined, undefined, screen));
check("cash: recorded with none", r === "", r);
r = await refusal(recordPayment(ORG, id(OPEN), pay({ reference: "UTR-77" }), undefined, undefined, undefined, screen));
check("its own: recorded", r === "" && (await doc(OPEN))?.payments?.some((p: any) => p.reference === "UTR-77"), r);
r = await refusal(recordPayment(ORG, id(OPEN), pay({}), undefined, undefined, undefined));
check("recorded by a script (not the screen): not held", r === "", r);

const old1 = (await doc(OLD1))!.payments[0];
r = await refusal(updatePayment(ORG, id(OLD1), String(old1._id), pay({ reference: "LEGACY-1", amountMinor: 12_000, paidOn: "2026-09-01" }), undefined, undefined, screen));
check("an old payment sharing its reference with another can still be corrected", r === "" && (await doc(OLD1))?.payments?.[0]?.amountMinor === 12_000, r);
r = await refusal(updatePayment(ORG, id(OLD1), String(old1._id), pay({ reference: "utr-77", amountMinor: 12_000, paidOn: "2026-09-01" }), undefined, undefined, screen));
check("…changed to one another payment has: refused", /Reference utr-77 is already on/.test(r), r);
r = await refusal(updatePayment(ORG, id(OLD1), String(old1._id), pay({ reference: "", amountMinor: 12_000, paidOn: "2026-09-01" }), undefined, undefined, screen));
check("…blanked: refused", /Enter the payment reference/.test(r), r);
r = await refusal(updatePayment(ORG, id(OLD1), String(old1._id), pay({ reference: "LEGACY-1B", amountMinor: 12_000, paidOn: "2026-09-01" }), undefined, undefined, screen));
check("…changed to its own: saved", r === "" && (await doc(OLD1))?.payments?.[0]?.reference === "LEGACY-1B", r);

/* ── 3 ── */
step("3. A CRM balance payment");
const incoming = await bp.intakeBalancePayment(ORG, {
  source: "crm", enrolmentExternalId: A.external.externalId, externalId: "pay-1", amountMinor: 20_000, method: "bank_transfer", paidOn: "2026-11-16",
  receipt: { name: "r.png", url: "https://files.e2e.test/r.png", key: "r.png" }, recordedBy: { name: "Rep", email: "" },
} as never);
r = await refusal(bp.decideBalancePayment(auth as never, incoming.id, { decision: "approved" }));
check("approved with no reference: refused", /Enter the payment reference/.test(r), r);
r = await refusal(bp.decideBalancePayment(auth as never, incoming.id, { decision: "approved", reference: "ORD-1" }));
check("…with one already used: refused, saying which", new RegExp(`already on ${A.invoiceNumber}`).test(r), r);
check("…still pending, and nobody holds it", (await bp.getBalancePayment(ORG, incoming.id)).status === "pending");
r = await refusal(bp.decideBalancePayment(auth as never, incoming.id, { decision: "approved", reference: "UTR-BAL-1" }));
check("…with its own: approved and recorded with it", r === "" && (await doc(A))?.payments?.some((p: any) => p.reference === "UTR-BAL-1" && p.amountMinor === 20_000), r);
const cashIn = await bp.intakeBalancePayment(ORG, {
  source: "crm", enrolmentExternalId: A.external.externalId, externalId: "pay-2", amountMinor: 10_000, method: "cash", paidOn: "2026-11-16",
  receipt: { name: "r.png", url: "https://files.e2e.test/r2.png", key: "r2.png" }, recordedBy: { name: "Rep", email: "" },
} as never);
r = await refusal(bp.decideBalancePayment(auth as never, cashIn.id, { decision: "approved" }));
check("a cash one needs none", r === "", r);

/* ── 4 ── */
step("4. Money out");
const expense = (over: Record<string, unknown> = {}) => ex.createExpense(ORG, ASHA, {
  category: "office_supplies", subcategory: "stationery", description: "Printer ink", expenseDate: "2026-11-10", amountMinor: 20_000, currency: "AED",
  categoryOther: "", taxPct: 0, taxInclusive: false, paymentAccount: "", reference: "", requiresApproval: false, isRecurring: false,
  paymentMethod: "bank_transfer", ...over,
} as never);
let e1 = await expense();
r = await refusal(ex.markExpensePaid(ORG, e1.id, { paidOn: "2026-11-11" } as never, { reference: true }));
check("an expense paid by transfer, marked paid with no reference: refused", /Enter the payment reference/.test(r), r);
e1 = await ex.markExpensePaid(ORG, e1.id, { paidOn: "2026-11-11", reference: "TRF-1" } as never, { reference: true });
check("…with one: paid, and it is kept", e1.paymentStatus === "paid" && e1.reference === "TRF-1", j({ s: e1.paymentStatus, r: e1.reference }));
const e2 = await expense({ reference: "CHQ-5" });
r = await refusal(ex.markExpensePaid(ORG, e2.id, { paidOn: "2026-11-11" } as never, { reference: true }));
check("one that already has its reference: paid", r === "", r);
const e3 = await expense({ paymentMethod: "cash" });
r = await refusal(ex.markExpensePaid(ORG, e3.id, { paidOn: "2026-11-11" } as never, { reference: true }));
check("cash: paid with none", r === "", r);
const e4 = await expense({ reference: "TRF-1" });
r = await refusal(ex.markExpensePaid(ORG, e4.id, { paidOn: "2026-11-11" } as never, { reference: true }));
check("money out may repeat a reference (one transfer paying several)", r === "", r);

const issues = (s: { safeParse: (v: unknown) => { success: boolean; error?: { issues: { path: (string | number)[]; message: string }[] } } }, v: unknown) => {
  const out = s.safeParse(v);
  return out.success ? [] : out.error!.issues.filter((i) => i.path[0] === "reference").map((i) => i.message);
};
const billPay = shared.withReference(shared.recordBillPaymentSchema, "method");
check("a bill payment by transfer without one: refused", issues(billPay, { method: "bank_transfer", amountMinor: 100, paidOn: "2026-11-11" }).length === 1);
check("…in cash: fine", issues(billPay, { method: "cash", amountMinor: 100, paidOn: "2026-11-11" }).length === 0);
const run = shared.withReference(payRunSchema, "method");
const acct = String(new Types.ObjectId());
check("a payroll payment by transfer without one: refused", issues(run, { bankAccountId: acct, method: "bank_transfer", paidOn: "2026-11-11" }).length === 1);
check("…with one: fine; in cash: fine", issues(run, { bankAccountId: acct, method: "bank_transfer", paidOn: "2026-11-11", reference: "WPS-11" }).length === 0
  && issues(run, { bankAccountId: acct, method: "cash", paidOn: "2026-11-11" }).length === 0);
const receipt = { name: "r.png", key: "r.png" };
const crm = shared.withReference(shared.payCrmCommissionSchema, "paymentMethod");
const crmPay = { crm: "delta", month: "2026-10", userId: "u1", paidOn: "2026-11-11", category: "x", receipt };
check("a CRM commission payout by cheque without one: refused", issues(crm, { ...crmPay, paymentMethod: "cheque" }).length === 1, j(crm.safeParse({ ...crmPay, paymentMethod: "cheque" })));
check("…with one: fine", crm.safeParse({ ...crmPay, paymentMethod: "cheque", reference: "CHQ-1" }).success);
const csPay = shared.withReference(shared.payCsCommissionSchema, "paymentMethod");
const csBody = { kind: "bonus", period: "2026-10", recipientId: "r1", paidOn: "2026-11-11", category: "x", receipt };
check("a CS commission payout by transfer without one: refused", issues(csPay, { ...csBody, paymentMethod: "bank_transfer" }).length === 1, j(csPay.safeParse({ ...csBody, paymentMethod: "bank_transfer" })));
check("…in cash: fine", csPay.safeParse({ ...csBody, paymentMethod: "cash" }).success);
const adv = shared.withReference(shared.approveAdvanceSchema, "paymentMethod");
check("whitespace alone is no reference", issues(adv, { hrmsOrgId: "h", paidOn: "2026-11-11", paymentMethod: "online", reference: "   " }).length === 1);

await mongoose.disconnect();
console.log(`\n${failures ? "\x1b[31m" : "\x1b[32m"}${checks - failures}/${checks} checks passed\x1b[0m`);
process.exit(failures ? 1 : 0);
