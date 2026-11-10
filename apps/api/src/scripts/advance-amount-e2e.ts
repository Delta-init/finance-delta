/**
 * Salary advances — finance paying a different amount than was asked (the user, 2026-11-10): approve()'s service,
 * against a stand-in HRMS that answers like the real one, in two versions — one that takes `amount` (it lists
 * requestedAmount) and one from before (it doesn't, and ignores `amount`). hrms-backend's
 * src/scripts/advanceAmountCheck.ts checks the real one's side: the recovery loan and payroll follow what was paid.
 *
 * What it proves:
 *   - paid as asked: the expense is the asked amount, and HRMS is sent no amount;
 *   - paid less: the expense is what was paid, its notes say so, HRMS is sent that amount;
 *   - paid more: refused without a note, nothing recorded; with one, recorded and sent;
 *   - against the older HRMS: a changed amount is refused before any expense — never booked at one figure and
 *     recovered at another; paying what was asked still works;
 *   - HRMS answering with another figure is not taken as told.
 *
 * Run through scripts/advance-amount-e2e.sh (throwaway mongod, no .env anywhere).
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
const { Expense } = await import("../modules/expense/expense.model");
const { User } = await import("../modules/user/user.model");
const adv = await import("../modules/advances/advances.service");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const j = (v: unknown) => JSON.stringify(v).slice(0, 400);
const refusal = async (p: Promise<unknown>) => p.then(() => "", (e: Error & { code?: string }) => `${e.code ?? ""} ${e.message}`);

/* ── The stand-in HRMS ── */
const H = new Types.ObjectId().toString();
const emp = (name: string) => ({ _id: name, name, employeeCode: `E-${name}`, designation: "Sales", department: null });
const queue = new Map<string, any>();
const waiting = (id: string, amount: number, months = 1) =>
  queue.set(id, { _id: id, amount, currency: "AED", reason: "Rent", neededBy: null, monthlySalary: 3500, months, startMonth: "2026-12", employee: emp(id), hrNote: "", createdAt: "2026-11-09T08:00:00.000Z" });
const stand = { old: false, liar: false, sent: [] as Array<{ id: string; body: any }> };
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const send = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (req.method === "GET" && url.pathname === "/api/v1/integrations/advances/requests") {
      // The newer HRMS always says requestedAmount; the older one never does.
      return send(200, { success: true, data: [...queue.values()].map((r) => (stand.old ? r : { ...r, requestedAmount: null })) });
    }
    const m = url.pathname.match(/^\/api\/v1\/integrations\/advances\/requests\/([^/]+)\/approve$/);
    if (req.method === "POST" && m) {
      const body = JSON.parse(raw || "{}");
      stand.sent.push({ id: m[1]!, body });
      const row = queue.get(m[1]!);
      if (!row) return send(404, { success: false, message: "Advance not found" });
      queue.delete(m[1]!);
      const paid = !stand.old && body.amount != null ? Number(body.amount) : row.amount;
      return send(200, { success: true, data: { ...row, status: "approved", amount: stand.liar ? row.amount : paid, requestedAmount: paid !== row.amount ? row.amount : null } });
    }
    send(404, { success: false, message: "Route not found" });
  });
});
await new Promise<void>((ok) => server.listen(PORT, "127.0.0.1", ok));

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();

const ORG = new Types.ObjectId().toString();
await PayrollOrgLink.collection.insertOne({ organizationId: new Types.ObjectId(ORG), hrmsOrgId: H, isActive: true });
const USER = new Types.ObjectId();
await User.collection.insertOne({ _id: USER, name: "Fina Finance", email: "fina@e2e.test", organizationId: new Types.ObjectId(ORG) });

const pay = (id: string, x: Record<string, unknown> = {}) => {
  return adv.approve(ORG, String(USER), id, {
    hrmsOrgId: H, category: "employee_advances", subcategory: "salary_advances", departmentId: "", note: "",
    paidOn: "2026-11-10", paymentMethod: "cash", reference: "", ...x,
  } as any);
};
const expenseOf = (id: string) => Expense.findOne({ "source.key": `hrms-advance:${H}:${id}` }).lean<any>();
const sentFor = (id: string) => stand.sent.filter((s) => s.id === id);

/* ── 1 ── */
step("1. Paid as asked");
waiting("same", 350);
await pay("same");
let e = await expenseOf("same");
check("expense AED 350, HRMS sent no amount", e?.totalMinor === 35_000 && sentFor("same").length === 1 && !("amount" in sentFor("same")[0]!.body), j({ e: e?.totalMinor, sent: sentFor("same") }));
waiting("typed-same", 350);
await pay("typed-same", { amountMinor: 35_000 });
check("the asked amount typed in: the same — no amount sent", !("amount" in (sentFor("typed-same")[0]?.body ?? { amount: 1 })), j(sentFor("typed-same")));

/* ── 2 ── */
step("2. Paid less");
waiting("less", 350);
const r = await pay("less", { amountMinor: 30_000 });
e = await expenseOf("less");
check("expense AED 300", r.expense.totalMinor === 30_000 && e?.totalMinor === 30_000, j(e?.totalMinor));
check("…its notes say 300 paid of 350 asked, and the recovery at 300", /Paid AED 300\.00 of AED 350\.00 asked/.test(e?.notes ?? "") && /AED 300\.00 a month × 1/.test(e?.notes ?? ""), e?.notes);
check("HRMS sent amount 300", sentFor("less")[0]?.body.amount === 300, j(sentFor("less")));
check("told: delivered", !!e?.source?.deliveredAt);

/* ── 3 ── */
step("3. Paid more");
waiting("more", 500, 2);
check("refused without a note", /needs a note/.test(await refusal(pay("more", { amountMinor: 60_000 }))));
check("…nothing recorded, HRMS not told", !(await expenseOf("more")) && sentFor("more").length === 0);
await pay("more", { amountMinor: 60_000, note: "Rent went up" });
e = await expenseOf("more");
check("with a note: expense 600, HRMS sent 600 and the note", e?.totalMinor === 60_000 && sentFor("more")[0]?.body.amount === 600 && sentFor("more")[0]?.body.note === "Rent went up", j(sentFor("more")));
check("…recovery in the notes over HR's 2 months: 300 a month", /AED 300\.00 a month × 2/.test(e?.notes ?? ""), e?.notes);

/* ── 4 ── */
step("4. An HRMS from before");
stand.old = true;
waiting("old-less", 350);
check("a changed amount: refused, saying HRMS needs updating", /UNAVAILABLE HRMS needs updating/.test(await refusal(pay("old-less", { amountMinor: 30_000 }))));
check("…no expense, HRMS not told", !(await expenseOf("old-less")) && sentFor("old-less").length === 0);
await pay("old-less");
check("paying what was asked still works", (await expenseOf("old-less"))?.totalMinor === 35_000 && sentFor("old-less").length === 1);
stand.old = false;

/* ── 5 ── */
step("5. HRMS answers with another figure");
stand.liar = true;
waiting("liar", 350);
const why = await refusal(pay("liar", { amountMinor: 30_000 }));
e = await expenseOf("liar");
check("not taken as told: says HRMS recorded 350", /HRMS recorded AED 350\.00/.test(why) && !e?.source?.deliveredAt, why);
stand.liar = false;

console.log(`\n${checks - failures}/${checks} checks passed`);
server.close();
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
