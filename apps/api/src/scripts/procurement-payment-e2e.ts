/**
 * Procurement, approve then pay (the user, 2026-10-26: "first approve time the expense will be marked as draft, then
 * after it is paid it will be updated, with the receipt, as paid"), against a scratch database through finance's
 * services, with HRMS stood in for.
 *
 * What it proves:
 *   - approving a purchase request makes its expense a draft, waiting for payment — who approved it kept — and HRMS is
 *     told its number as before; it counts nowhere: not in payables, the month's expenses, or the budget's spend;
 *   - it is not sent for approval, nor marked paid without its receipt; Record payment refuses with no receipt on it;
 *   - Record payment, with the receipt: approved and paid, its line in the bank account, at what it actually cost
 *     (noted against what was approved), and it counts from then on — in payables no more, in money out;
 *   - only a waiting procurement expense is paid that way; Mark unpaid puts one back to waiting;
 *   - the Procurement list says waiting or paid;
 *   - the one-off script: approved, unpaid procurement expenses from before become drafts; paid ones and ones with a
 *     bank line stay; undo puts back only what is still waiting.
 *
 * Run through scripts/procurement-payment-e2e.sh (throwaway mongod, no .env anywhere).
 */
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import mongoose, { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}

const { hrmsClient } = await import("../lib/hrms-client");
const { Expense } = await import("../modules/expense/expense.model");
const proc = await import("../modules/procurement/procurement.service");
const ex = await import("../modules/expense/expense.service");
const dash = await import("../modules/dashboard/dashboard.service");
const script = await import("./procurement-to-draft");
const { approveProcurementSchema } = await import("@delta/shared");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const j = (v: unknown) => String(JSON.stringify(v)).slice(0, 400);
async function refused(p: Promise<unknown>, like: RegExp): Promise<string> {
  try { await p; return "not refused"; } catch (e) { const m = (e as Error).message; return like.test(m) ? "" : m; }
}

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();
const db = mongoose.connection.db!;
const ORG = new Types.ObjectId(), org = String(ORG);
const me = new Types.ObjectId();
await db.collection("organizations").insertOne({ _id: ORG, name: "Delta HQ", baseCurrency: "AED" });
await db.collection("users").insertOne({ _id: me, name: "Accountant Ammu", email: "ammu@e2e.local", status: "active", memberships: [{ organizationId: ORG, status: "active" }] });
const HRMS_ORG = "hrms-org-1";
await db.collection("payrollorglinks").insertOne({ organizationId: ORG, hrmsOrgId: HRMS_ORG, isActive: true });
const bank = (await db.collection("bankaccounts").insertOne({
  organizationId: ORG, accountName: "ADCB Current", accountType: "current", currency: "AED", currentBalanceMinor: 0,
  openingBalanceMinor: 10_000_000, openingDate: new Date("2026-01-01"), isActive: true,
})).insertedId;
const today = new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10);

// HRMS, stood in for: one request waiting on finance; what finance told it; the full record.
const told: { requestId: string; ref: string }[] = [];
const request = { _id: "req-1", item: "Office chairs", category: "Furniture", quantity: 4, estimatedCost: 1200, currency: "AED", resubmitCount: 0,
  department: null, requestedBy: { _id: "u1", name: "Hiba" }, createdAt: new Date().toISOString() };
let waiting = [request];
Object.assign(hrmsClient, {
  isConfigured: () => true,
  procurementRequests: async () => waiting,
  approveProcurement: async (_o: string, requestId: string, body: { purchaseOrderRef: string }) => { told.push({ requestId, ref: body.purchaseOrderRef }); waiting = []; return {}; },
  procurementHistory: async () => [{ ...request, kind: "new", status: "approved" }],
});

step("1. Approving makes a draft, waiting for payment");
const res = await proc.approve(org, String(me), "req-1", approveProcurementSchema.parse({
  hrmsOrgId: HRMS_ORG, amountMinor: 120000, category: "other_unclassified", subcategory: "pending_classification", categoryOther: "Furniture",
}));
const id = res.expense.id;
let e = await ex.getExpense(org, id, { all: true } as never);
check("its expense is a draft, waiting for payment", e.status === "draft" && e.awaitingPayment === true, j([e.status, e.awaitingPayment]));
check("…who approved it is kept", e.approvedByName === "Accountant Ammu" && !!e.approvedAt, j([e.approvedByName, e.approvedAt]));
check("HRMS is told its number, as before", told.length === 1 && told[0]!.ref === e.expenseNumber, j(told));
let s = await dash.getDashboardStats(org);
check("it counts nowhere: not in payables, not in this month's expenses", s.kpi.payablesExpenses === 0 && s.kpi.netProfitMtd === 0, j(s.kpi));
const budgetSpend = await Expense.countDocuments({ organizationId: ORG, status: "approved" });
check("…nor a budget's spend (budgets count approved expenses only)", budgetSpend === 0);

step("2. Not sent round, not paid without a receipt");
check("Submit is refused — record its payment instead", !(await refused(ex.submitExpense(org, id, { all: true } as never), /record its payment/)));
check("Mark paid is refused — it needs its receipt", !(await refused(ex.markExpensePaid(org, id, { paidOn: today }), /record its payment with the receipt/)));
check("Record payment with no receipt on it: refused", !(await refused(ex.recordProcurementPayment(org, id, { paidOn: today }, String(me)), /Attach the receipt/)));

step("3. Paid, with its receipt");
await Expense.updateOne({ _id: id }, { $push: { attachments: { name: "chairs-receipt.pdf", key: `expenses/${org}/uploads/r.pdf`, url: "https://files.example/r.pdf", uploadedAt: new Date() } } } as never);
e = await ex.recordProcurementPayment(org, id, { paidOn: today, bankAccountId: String(bank), paymentMethod: "bank_transfer", amountMinor: 115000 }, String(me));
check("approved and paid, today", e.status === "approved" && e.paidOn === today && !e.awaitingPayment, j([e.status, e.paidOn, e.awaitingPayment]));
check("at what it actually cost, noted against what was approved", e.totalMinor === 115000 && /Paid AED 1150\.00 — approved AED 1200\.00 \(Accountant Ammu\)/.test(e.notes), j([e.totalMinor, e.notes]));
const line = await db.collection("banktransactions").findOne({ organizationId: ORG, accountId: bank });
check("its line is in the bank account, money out", !!line && e.inBank === true, j([line?.amountMinor, line?.type, e.inBank, e.bankNote]));
s = await dash.getDashboardStats(org);
const cur = s.months.current;
check("it counts now: in money out, not in payables", s.cashflow.find((c) => c.key === cur)?.outflowMinor === 115000 && s.kpi.payablesExpenses === 0, j(s.cashflow.at(-1)));
check("Record payment again: refused — not waiting", !(await refused(ex.recordProcurementPayment(org, id, { paidOn: today }, String(me)), /not waiting for payment/)));

step("4. Only a waiting purchase is paid that way; Mark unpaid puts it back");
const typed = (await Expense.create({
  organizationId: ORG, expenseNumber: "EXP-T1", category: "other_unclassified", categoryName: "Other", description: "Taxi", expenseDate: new Date(today),
  amountMinor: 5000, taxMinor: 0, totalMinor: 5000, currency: "AED", status: "draft", submittedById: me, submittedByName: "Ammu",
  attachments: [{ name: "r.pdf", key: `expenses/${org}/uploads/t.pdf`, url: "https://files.example/t.pdf" }],
}))._id;
check("a typed-in draft: refused — use Mark paid", !(await refused(ex.recordProcurementPayment(org, String(typed), { paidOn: today }, String(me)), /use Mark paid/)));
check("…and it is still submitted as usual", (await ex.submitExpense(org, String(typed), { all: true } as never)).status === "submitted");
e = await ex.markExpenseUnpaid(org, id);
check("Mark unpaid: waiting for payment again, its receipt kept", e.status === "draft" && e.awaitingPayment === true && !e.paidOn && e.attachments.length === 1, j([e.status, e.paidOn, e.attachments.length]));
check("…its bank line gone", !(await db.collection("banktransactions").findOne({ organizationId: ORG, accountId: bank })));
e = await ex.recordProcurementPayment(org, id, { paidOn: today, bankAccountId: String(bank) }, String(me));
check("paid again (receipt already on it, amount as it was)", e.status === "approved" && e.totalMinor === 115000, j([e.status, e.totalMinor]));

step("5. The Procurement list says waiting or paid");
let hist = await proc.listHistory(org, "all");
check("paid, with its day", hist[0]?.expense?.awaitingPayment === false && hist[0]?.expense?.paidOn === today, j(hist[0]?.expense));
await ex.markExpenseUnpaid(org, id);
hist = await proc.listHistory(org, "all");
check("waiting for payment", hist[0]?.expense?.awaitingPayment === true && hist[0]?.expense?.paidOn === null, j(hist[0]?.expense));

step("6. The one-off script for the ones approved before");
const old = (n: string, o: Record<string, unknown>) => ({
  organizationId: ORG, expenseNumber: n, category: "other_unclassified", categoryName: "Other", description: n, expenseDate: new Date(today),
  amountMinor: 1000, taxMinor: 0, totalMinor: 1000, currency: "AED", submittedById: me, submittedByName: "Ammu", attachments: [],
  source: { kind: "hrms_procurement", key: `hrms:${HRMS_ORG}:${n}:0`, hrmsOrgId: HRMS_ORG, requestId: n, round: 0 }, ...o,
});
await Expense.create([
  old("EXP-OLD1", { status: "approved", paidOn: null }),
  old("EXP-OLD2", { status: "approved", paidOn: new Date(today) }),
  old("EXP-OLD3", { status: "approved", paidOn: null, bankTransactionId: new Types.ObjectId() }),
  old("EXP-OLD4", { status: "voided", paidOn: null }),
]);
const plan = await script.planProcurementDrafts();
check("plans only the approved, unpaid one with no bank line", j(plan.map((p) => p.expenseNumber)) === j(["EXP-OLD1"]), j(plan.map((p) => p.expenseNumber)));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proc-draft-"));
const { changed, file } = await script.runProcurementDrafts(dir);
const o1 = await Expense.findOne({ expenseNumber: "EXP-OLD1" }).lean<any>();
check("it is a draft now, waiting for payment; the others as they were", changed.length === 1 && o1.status === "draft"
  && (await Expense.findOne({ expenseNumber: "EXP-OLD2" }).lean<any>()).status === "approved" && (await Expense.findOne({ expenseNumber: "EXP-OLD3" }).lean<any>()).status === "approved");
check("a second run has nothing to do", (await script.planProcurementDrafts()).length === 0);
check("a dry undo changes nothing", /would be approved again/.test((await script.undoProcurementDrafts(file, false))[0] ?? "") && (await Expense.findOne({ expenseNumber: "EXP-OLD1" }).lean<any>()).status === "draft");
await script.undoProcurementDrafts(file, true);
check("undone: approved again", (await Expense.findOne({ expenseNumber: "EXP-OLD1" }).lean<any>()).status === "approved");
fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} passed`);
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
