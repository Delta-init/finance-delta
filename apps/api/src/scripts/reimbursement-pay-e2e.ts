/**
 * Reimbursements (the user, 2026-11-16: "employee request => HR approval => finance approval (paid status)"): the
 * finance side — the waiting list, Approve and pay, Refuse, the record and the Approvals page — against a stand-in
 * HRMS that answers like the real one. hrms-backend's src/scripts/reimbursementFinanceCheck.ts checks the real one's
 * side: the claim becomes Paid with the expense number, never goes into a payslip, and the employee is told.
 *
 * What it proves:
 *   - the list: both linked HRMS organisations, oldest HR approval first, the suggested department and subcategory;
 *   - paying: one paid expense for the amount claimed — the claim's currency, spent date, the employee's code in the
 *     notes — then HRMS is sent the expense number, date, method, amount and who paid;
 *   - HRMS not answering: the expense stays, the claim shows it, paying again resends — no second expense;
 *   - refusing: needs a reason; refused while an expense exists, or once voided paying is refused;
 *   - the record, Approvals (summary and list), an HRMS without the step (404: "needs updating"; counted as 0);
 *   - another amount than claimed (2026-11-16): less — the expense and HRMS get it; more — refused without a note;
 *     an HRMS from before (no requestedAmount) — refused before any expense, paying as claimed still works; HRMS
 *     answering with another figure is not taken as told.
 *
 * Run through scripts/reimbursement-pay-e2e.sh (throwaway mongod, no .env anywhere).
 */
import http from "node:http";
import mongoose, { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}
const PORT = Number(new URL(process.env.HRMS_API_URL ?? "http://127.0.0.1:0").port);

const { PayrollOrgLink } = await import("../modules/payroll-mapping/org-link.model");
const { PayrollDeptLink } = await import("../modules/payroll-mapping/dept-link.model");
const { Department } = await import("../modules/department/department.model");
const { Expense } = await import("../modules/expense/expense.model");
const { User } = await import("../modules/user/user.model");
const svc = await import("../modules/reimbursements/reimbursements.service");
const approvals = await import("../modules/approvals/approvals.service");
const { rejectReimbursementSchema, payReimbursementSchema } = await import("@delta/shared");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const j = (v: unknown) => JSON.stringify(v).slice(0, 500);
const refusal = async (p: Promise<unknown>) => p.then(() => "", (e: Error & { code?: string }) => `${e.code ?? ""} ${e.message}`);

/* ── The stand-in HRMS: its queue per organisation, its record, what it was sent ── */
const H = new Types.ObjectId().toString();   // Delta HQ's HRMS org
const H2 = new Types.ObjectId().toString();  // a second linked one, in rupees
const HDEPT = new Types.ObjectId().toString();
const queue = new Map<string, Map<string, any>>([[H, new Map()], [H2, new Map()]]);
const decided: any[] = [];
const stand = { down: false, old: false, noAmounts: false, liar: false, sent: [] as Array<{ id: string; path: string; body: any }> };
const claim = (org: string, id: string, x: Record<string, unknown> = {}) => {
  queue.get(org)!.set(id, {
    _id: id, title: `Claim ${id}`, category: "travel", amount: 85, currency: org === H2 ? "INR" : "AED", expenseDate: "2026-11-12", month: "2026-11",
    description: "", receiptUrl: `https://files.e2e.test/${id}.jpg`, status: "hr_approved",
    employee: { _id: `e-${id}`, name: "Sami Staff", employeeCode: "EMP-014", designation: "Agent", department: { _id: HDEPT, name: "Sales" } },
    user: { name: "Sami Staff", email: "staff@e2e.test" }, hrReviewedBy: { name: "Hana HR" }, hrReviewedAt: "2026-11-15T09:00:00.000Z", hrNote: "",
    createdAt: "2026-11-12T08:00:00.000Z", rejectedBy: null, financeRef: "", paidOn: null, paymentMethod: "", financeNote: "", financeReviewedBy: "",
    financeReviewedAt: null, requestedAmount: null, ...x,
  });
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const send = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (stand.old) return send(404, { success: false, message: "Route not found" });
    const org = url.searchParams.get("organizationId") ?? "";
    const q = queue.get(org);
    if (req.method === "GET" && url.pathname === "/api/v1/integrations/reimbursements/requests") {
      const status = url.searchParams.get("status");
      // An HRMS from before 2026-11-16 never says requestedAmount.
      if (!status) return send(200, { success: true, data: [...(q?.values() ?? [])].map((r) => (stand.noAmounts ? (({ requestedAmount: _, ...rest }) => rest)(r) : r)) });
      const mine = decided.filter((d) => d.org === org).map((d) => d.row);
      return send(200, { success: true, data: status === "all" ? mine : mine.filter((r) => r.status === status) });
    }
    const m = url.pathname.match(/^\/api\/v1\/integrations\/reimbursements\/requests\/([^/]+)\/(approve|reject)$/);
    if (req.method === "POST" && m) {
      const body = JSON.parse(raw || "{}");
      stand.sent.push({ id: m[1]!, path: m[2]!, body });
      if (stand.down) return send(500, { success: false, message: "HRMS is having a moment" });
      const row = q?.get(m[1]!);
      if (!row) return send(404, { success: false, message: "Claim not found" });
      q!.delete(m[1]!);
      const paidAt = body.amount != null ? Number(body.amount) : row.amount;
      if (m[2] === "approve" && stand.noAmounts && paidAt !== row.amount) return send(409, { success: false, message: "This claim is for another amount" });
      const changed = m[2] === "approve" && !stand.liar && paidAt !== row.amount ? { amount: paidAt, requestedAmount: row.amount } : {};
      const done = m[2] === "approve"
        ? { ...row, ...changed, status: "paid", financeRef: body.reference, paidOn: body.paidOn, paymentMethod: body.method, financeNote: body.note ?? "", financeReviewedBy: body.by ?? "", financeReviewedAt: new Date().toISOString() }
        : { ...row, status: "rejected", rejectedBy: "finance", financeNote: body.note, financeReviewedBy: body.by ?? "", financeReviewedAt: new Date().toISOString() };
      decided.unshift({ org, row: done });
      return send(200, { success: true, data: done });
    }
    send(404, { success: false, message: "Route not found" });
  });
});
await new Promise<void>((ok) => server.listen(PORT, "127.0.0.1", ok));

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();

const ORG = new Types.ObjectId().toString();
const OTHER = new Types.ObjectId().toString();
await PayrollOrgLink.collection.insertMany([
  { organizationId: new Types.ObjectId(ORG), hrmsOrgId: H, hrmsOrgName: "Delta HQ", isActive: true },
  { organizationId: new Types.ObjectId(ORG), hrmsOrgId: H2, hrmsOrgName: "Delta Bangalore", isActive: true },
  { organizationId: new Types.ObjectId(OTHER), hrmsOrgId: new Types.ObjectId().toString(), hrmsOrgName: "Elsewhere", isActive: true },
]);
const SALES = new Types.ObjectId();
await Department.collection.insertOne({ _id: SALES, organizationId: new Types.ObjectId(ORG), name: "Sales" });
await PayrollDeptLink.collection.insertOne({ organizationId: new Types.ObjectId(ORG), hrmsOrgId: H, hrmsDepartmentId: HDEPT, departmentId: SALES, isActive: true });
const USER = new Types.ObjectId();
await User.collection.insertOne({ _id: USER, name: "Fina Finance", email: "fina@e2e.test", organizationId: new Types.ObjectId(ORG) });
const auth = { userId: String(USER), organizationId: ORG, role: "Admin", permissions: ["expense:approve"], isSuperAdmin: false };

const pay = (org: string, id: string, x: Record<string, unknown> = {}) => svc.pay(ORG, String(USER), id, payReimbursementSchema.parse({
  hrmsOrgId: org, category: "employee_reimbursements", subcategory: "staff_meals", departmentId: String(SALES), note: "",
  paidOn: "2026-11-16", paymentMethod: "bank_transfer", reference: "", ...x,
}));
const expensesOf = (org: string, id: string) => Expense.find({ "source.key": `hrms-reimbursement:${org}:${id}` }).lean<any[]>();
const sentFor = (id: string) => stand.sent.filter((s) => s.id === id);

/* ── 1 ── */
step("1. The waiting list");
claim(H, "lunch", { title: "Lunch with the team", category: "food", amount: 180, hrReviewedAt: "2026-11-14T09:00:00.000Z" });
claim(H, "taxi", { title: "Taxi to client meeting", hrReviewedAt: "2026-11-15T09:00:00.000Z" });
claim(H2, "fuel", { title: "Fuel for office run", category: "fuel", amount: 1200, employee: { _id: "e-b", name: "Bina B", employeeCode: "BLR-007", designation: "Agent", department: null }, hrReviewedAt: "2026-11-13T09:00:00.000Z" });
const waiting = await svc.listWaiting(ORG);
check("both linked HRMS organisations, oldest HR approval first", waiting.map((r) => r._id).join() === "fuel,lunch,taxi", j(waiting.map((r) => r._id)));
const lunch = waiting.find((r) => r._id === "lunch")!;
check("each says which HRMS organisation it is from", lunch.hrmsOrgId === H && waiting.find((r) => r._id === "fuel")!.hrmsOrgId === H2);
check("the employee's HRMS department suggests finance's Sales", lunch.suggestedDepartmentId === String(SALES), j(lunch.suggestedDepartmentId));
check("food suggests Staff Meals; fuel the default Other Approved Staff Claims",
  lunch.suggestedSubcategory === "staff_meals" && waiting.find((r) => r._id === "fuel")!.suggestedSubcategory === "other_staff_claims");
check("communication suggests Mobile Expenses", svc.suggestedSubcategory("communication") === "mobile_expenses");
check("no expense yet", waiting.every((r) => r.expense === null));

/* ── 2 ── */
step("2. Approve and pay");
const paid = await pay(H, "lunch", { note: "Paid with the week's claims", reference: "TRF-1" });
let ex = await expensesOf(H, "lunch");
const e = ex[0];
check("one expense, approved and paid, for the amount claimed", ex.length === 1 && e.status === "approved" && e.totalMinor === 18_000 && e.currency === "AED" && paid.expense.expenseNumber === e.expenseNumber, j(ex));
check("…Employee Reimbursements › Staff Meals, in Sales", e.category === "employee_reimbursements" && e.subcategory === "staff_meals" && String(e.departmentId) === String(SALES), j({ c: e.category, s: e.subcategory, d: e.departmentId }));
check("…dated the day it was spent, paid on the day given, by the method given", e.expenseDate.toISOString().slice(0, 10) === "2026-11-12" && e.paidOn.toISOString().slice(0, 10) === "2026-11-16" && e.paymentMethod === "bank_transfer" && e.reference === "TRF-1");
check("…the notes name the employee with their code, the receipt and HR's approver", /\(EMP-014\)/.test(e.notes) && /files\.e2e\.test\/lunch\.jpg/.test(e.notes) && /Hana HR/.test(e.notes) && /Paid with the week's claims/.test(e.notes), e.notes);
check("…its source: hrms_reimbursement, told", e.source?.kind === "hrms_reimbursement" && e.source?.requestId === "lunch" && !!e.source?.deliveredAt, j(e.source));
const told = sentFor("lunch")[0]?.body;
check("HRMS was sent the expense number, date, method, amount and who paid",
  told?.reference === e.expenseNumber && told?.paidOn === "2026-11-16" && told?.method === "bank_transfer" && told?.amount === 180 && told?.by === "Fina Finance" && told?.note === "Paid with the week's claims",
  j(told));
check("it left the queue", !(await svc.listWaiting(ORG)).some((r) => r._id === "lunch"));
check("paying it again: no longer waiting", /NOT_FOUND/.test(await refusal(pay(H, "lunch"))));
const rupees = await pay(H2, "fuel", { category: "employee_reimbursements", subcategory: "other_staff_claims" });
check("a rupee claim: paid in rupees", rupees.expense.currency === "INR" && rupees.expense.totalMinor === 120_000, j(rupees));

/* ── 3 ── */
step("3. HRMS not answering");
stand.down = true;
const why = await refusal(pay(H, "taxi"));
ex = await expensesOf(H, "taxi");
check("says the expense is recorded and HRMS could not be told", /UNAVAILABLE EXP-\d+ has been recorded, but HRMS could not be told/.test(why), why);
check("…one expense, not told", ex.length === 1 && !ex[0].source?.deliveredAt, j(ex));
const shown = (await svc.listWaiting(ORG)).find((r) => r._id === "taxi");
check("the waiting claim shows that expense", shown?.expense?.expenseNumber === ex[0].expenseNumber, j(shown?.expense));
check("refusing it now is refused: void it first", /CONFLICT .*already been recorded/.test(await refusal(svc.reject(ORG, String(USER), "taxi", { hrmsOrgId: H, note: "Changed our mind" }))));
stand.down = false;
await pay(H, "taxi", { subcategory: "business_travel" });
ex = await expensesOf(H, "taxi");
// The resend asks for Business Travel; the expense keeps what it was first recorded as (Staff Meals, the helper's).
check("paying again resends: still one expense, now told, as first recorded", ex.length === 1 && !!ex[0].source?.deliveredAt && ex[0].subcategory === "staff_meals" && sentFor("taxi").at(-1)?.body.reference === ex[0].expenseNumber, j(ex.map((x) => [x.subcategory, x.source])));

/* ── 4 ── */
step("4. Refusing");
check("a refusal with no reason is refused (the form's rule)", !rejectReimbursementSchema.safeParse({ hrmsOrgId: H, note: " no " }).success);
claim(H, "phone", { title: "Mobile top-up", category: "communication", amount: 50 });
await svc.reject(ORG, String(USER), "phone", rejectReimbursementSchema.parse({ hrmsOrgId: H, note: "Receipt can't be read" }));
const refused = sentFor("phone")[0];
check("HRMS was sent the reason and who refused", refused?.path === "reject" && refused.body.note === "Receipt can't be read" && refused.body.by === "Fina Finance", j(refused));
check("no expense for it", (await expensesOf(H, "phone")).length === 0);
check("a claim of an organisation not linked: forbidden", /FORBIDDEN/.test(await refusal(pay(new Types.ObjectId().toString(), "x"))));

claim(H, "void", { title: "Voided one" });
stand.down = true;
await refusal(pay(H, "void"));
stand.down = false;
await Expense.updateOne({ "source.key": `hrms-reimbursement:${H}:void` }, { $set: { status: "voided" } });
check("its expense voided: paying is refused, saying refuse it instead", /CONFLICT .*voided\. Refuse the claim instead/.test(await refusal(pay(H, "void"))));
await svc.reject(ORG, String(USER), "void", { hrmsOrgId: H, note: "Paid by mistake elsewhere" });
check("…and refusing works", sentFor("void").some((s) => s.path === "reject"));

/* ── 5 ── */
step("5. The record");
const paidList = await svc.listHistory(ORG, "paid");
check("Paid: the three paid, each with its expense", paidList.length === 3 && paidList.every((r) => r.status === "paid" && !!r.expense), j(paidList.map((r) => [r._id, r.expense?.expenseNumber])));
const refusedList = await svc.listHistory(ORG, "rejected");
check("Refused: the two refused, with the reason", refusedList.map((r) => r._id).sort().join() === "phone,void" && refusedList.some((r) => r.financeNote === "Receipt can't be read"), j(refusedList.map((r) => r._id)));
check("All: five", (await svc.listHistory(ORG, "all")).length === 5);

/* ── 6 ── */
step("6. Approvals");
claim(H, "hotel", { title: "Hotel for the expo", category: "accommodation", amount: 400 });
approvals.forgetReimbursements(H); approvals.forgetReimbursements(H2);
const summary = await approvals.approvalSummary(auth as never);
const group = summary.groups.find((g) => g.type === "reimbursement");
check("the summary counts the one waiting, linking to the page", group?.count === 1 && group.href === "/reimbursements" && group.items[0]?.amountMinor === 40_000, j(group));
const pending = await approvals.approvalList(auth as never, { status: "pending", type: "reimbursement", page: 1, pageSize: 20 } as never);
check("the list: waiting, read live from HRMS", pending.rows.length === 1 && pending.rows[0]!.title === "Hotel for the expo — Sami Staff" && pending.rows[0]!.href === "/reimbursements", j(pending.rows));
const approvedRows = await approvals.approvalList(auth as never, { status: "approved", type: "reimbursement", page: 1, pageSize: 20 } as never);
check("…approved: the three paid, by their expense, and who paid", approvedRows.rows.length === 3 && approvedRows.rows.every((r) => r.decidedBy === "Fina Finance" && /^\/expenses\//.test(r.href ?? "")), j(approvedRows.rows));
const noRight = await approvals.approvalSummary({ ...auth, permissions: ["invoice:approve"] } as never);
check("not counted for somebody without expense:approve", !noRight.groups.some((g) => g.type === "reimbursement"));

/* ── 7 ── */
step("7. Another amount than claimed");
claim(H, "less", { title: "Hotel for the expo", amount: 400 });
const less = await pay(H, "less", { amountMinor: 30_000 });
let le = (await expensesOf(H, "less"))[0];
check("paid less: the expense is 300", less.expense.totalMinor === 30_000 && le?.totalMinor === 30_000, j(le?.totalMinor));
check("…its notes say 300 paid of 400 claimed", /Paid AED 300\.00 of AED 400\.00 claimed — changed by finance/.test(le?.notes ?? ""), le?.notes);
check("…HRMS was sent 300, and is told", sentFor("less")[0]?.body.amount === 300 && !!le?.source?.deliveredAt, j(sentFor("less")));
check("…the record shows 300 of 400 claimed", (await svc.listHistory(ORG, "paid")).some((r) => r._id === "less" && r.amount === 300 && r.requestedAmount === 400));
claim(H, "more", { title: "Parking at the venue", amount: 30 });
check("paid more with no note: refused", /needs a note saying why/.test(await refusal(pay(H, "more", { amountMinor: 3_500 }))));
check("…nothing recorded, HRMS not told", (await expensesOf(H, "more")).length === 0 && sentFor("more").length === 0);
await pay(H, "more", { amountMinor: 3_500, note: "The ticket was 35" });
check("with a note: expense 35, HRMS sent 35 and the note", (await expensesOf(H, "more"))[0]?.totalMinor === 3_500 && sentFor("more")[0]?.body.amount === 35 && sentFor("more")[0]?.body.note === "The ticket was 35", j(sentFor("more")));
claim(H, "same", { title: "Typed the same", amount: 50 });
await pay(H, "same", { amountMinor: 5_000 });
check("the amount claimed typed in: paid as claimed", (await expensesOf(H, "same"))[0]?.totalMinor === 5_000 && !/changed by finance/.test((await expensesOf(H, "same"))[0]?.notes ?? ""));
stand.noAmounts = true;
claim(H, "old", { title: "Before the update", amount: 80 });
check("an HRMS from before: a changed amount is refused, saying HRMS needs updating", /UNAVAILABLE HRMS needs updating/.test(await refusal(pay(H, "old", { amountMinor: 6_000 }))));
check("…no expense, HRMS not told", (await expensesOf(H, "old")).length === 0 && sentFor("old").length === 0);
await pay(H, "old");
check("…paying as claimed still works", (await expensesOf(H, "old"))[0]?.totalMinor === 8_000 && sentFor("old").length === 1);
stand.noAmounts = false;
stand.liar = true;
claim(H, "liar", { title: "Answered with another figure", amount: 90 });
const lied = await refusal(pay(H, "liar", { amountMinor: 7_000 }));
check("HRMS answering with another figure: not taken as told", /HRMS recorded AED 90\.00/.test(lied) && !(await expensesOf(H, "liar"))[0]?.source?.deliveredAt, lied);
stand.liar = false;

/* ── 8 ── */
step("8. An HRMS without the step");
stand.old = true;
approvals.forgetReimbursements(H); approvals.forgetReimbursements(H2);
check("the page says HRMS needs updating", /UNAVAILABLE HRMS needs updating/.test(await refusal(svc.listWaiting(ORG))));
const oldSummary = await approvals.approvalSummary(auth as never);
const oldGroup = oldSummary.groups.find((g) => g.type === "reimbursement");
check("Approvals counts none — not \"could not be read\" on every sidebar", oldGroup?.count === 0 && !oldGroup.unavailable, j(oldGroup));
stand.old = false;

server.close();
await mongoose.disconnect();
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
