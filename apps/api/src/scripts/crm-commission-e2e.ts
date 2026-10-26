/**
 * The sales CRMs' commission in finance (the user, 2026-10-21: "commission of each CRM needs to show here, a manager
 * approves, then accounts mark it paid with the receipt") — finance's service in the test itself, against a stand-in
 * Root portal that checks finance's secret and answers like the real one (root-sales-crm's crm-commission-check
 * checks the real one).
 *
 * What it proves:
 *   - a month per CRM and person, earned until approved; who may approve and pay;
 *   - only a manager (or a super admin) approves — the amount frozen — and only once; an approval can be taken back
 *     before it is paid;
 *   - paying needs an approval and the receipt uploaded here; it records one paid expense for the approved amount,
 *     the receipt on it, and can't be paid twice — not from another organization either;
 *   - a figure that changes in the CRM after approval is flagged; a payout whose sales all went still shows;
 *   - Root not set up, out of date or down says so.
 *   - what is approved and paid is the CRM's My Pay "commission payable" (2026-10-21) — earned × the slab level's
 *     percent — shown with the earned figure; nothing payable, or a CRM whose My Pay figures are missing, can't be
 *     approved; the CRMs read their payouts back for My Pay.
 *
 * Run through scripts/crm-commission-e2e.sh (throwaway mongod, no .env anywhere).
 */
import http from "node:http";
import mongoose, { Types } from "mongoose";
import { approveCrmCommissionSchema, payCrmCommissionSchema } from "@delta/shared";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}
const SECRET = process.env.ROOT_ERP_SECRET ?? "";
const PORT = Number(new URL(process.env.ROOT_ERP_API_URL ?? "http://127.0.0.1:0").port);

const { Organization } = await import("../modules/organization/organization.model");
const { User } = await import("../modules/user/user.model");
const { Role } = await import("../modules/role/role.model");
const { Expense } = await import("../modules/expense/expense.model");
const { env } = await import("../config/env");
const svc = await import("../modules/crm-commission/crm-commission.service");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const j = (v: unknown) => JSON.stringify(v).slice(0, 400);
const refusal = async (p: Promise<unknown>) => p.then(() => "", (e: Error & { code?: string }) => `${e.code ?? ""} ${e.message}`);

/* ── A stand-in Root: the month's counted commission, changeable mid-test ── */
const RIA = new Types.ObjectId().toString(), ABRAR = new Types.ObjectId().toString(), IRFANA = new Types.ObjectId().toString();
const LENA = new Types.ObjectId().toString(), NUSRA = new Types.ObjectId().toString();
const line = (role: string, amount: number, student = "S1") => ({ saleId: `sale-${student}`, saleDate: "2026-10-03T08:00:00.000Z", student, course: "Delta Wave Theory", invoiceNumber: `IN-${student}`, role, amount });
const root = {
  mode: "ok" as "ok" | "old" | "down",
  hits: [] as Array<{ month: string | null; signed: boolean }>,
  crms: [
    { code: "delta", name: "Sales CRM", currency: "AED", error: null, total: 1320, payableTotal: 720, payError: null, pending: { progress: 1, waiting: 0 }, people: [
      { userId: RIA, name: "Ria", roles: ["sales"], amount: 1200, payable: 600, percent: 50, level: "Level 2", sales: 2, lines: [line("sales", 500), line("sales", 700, "S2")] },
      { userId: ABRAR, name: "Abrar", roles: ["sm"], amount: 120, payable: 120, percent: 100, level: "Level 1", sales: 2, lines: [line("sm", 50), line("sm", 70, "S2")] },
      { userId: LENA, name: "Lena", roles: ["tl"], amount: 300, payable: 0, percent: 0, level: "Base", sales: 1, lines: [line("tl", 300, "S3")] },
    ] },
    { code: "draw", name: "Draw", currency: "AED", error: null, total: 250, payableTotal: 100, payError: null, pending: { progress: 0, waiting: 0 }, people: [
      { userId: IRFANA, name: "Irfana", roles: ["sales"], amount: 250, payable: 100, percent: 40, level: "Level 1", sales: 1, lines: [line("sales", 250, "D1")] },
    ] },
    { code: "remote", name: "Remote CRM", currency: "AED", error: null, total: 90, payableTotal: null, payError: "Remote CRM is not configured on this server — set REMOTE_API_URL", pending: { progress: 0, waiting: 0 }, people: [
      { userId: NUSRA, name: "Nusra", roles: ["sales"], amount: 90, payable: null, percent: null, level: null, sales: 1, lines: [line("sales", 90, "R1")] },
    ] },
    { code: "banglore", name: "Banglore CRM", currency: "INR", error: "No database URI configured", total: 0, payableTotal: null, payError: null, pending: { progress: 0, waiting: 0 }, people: [] },
  ] as any[],
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const signed = req.headers["x-portal-secret"] === SECRET;
  root.hits.push({ month: url.searchParams.get("month"), signed });
  const send = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (root.mode === "old" || url.pathname !== "/api/v1/service/crm-commission") return send(404, { success: false, message: "Route not found" });
  if (!signed) return send(401, { success: false, message: "Invalid service credential" });
  send(200, { success: true, message: "CRM commission", data: { month: url.searchParams.get("month"), crms: root.crms } });
});
await new Promise<void>((ok) => server.listen(PORT, "127.0.0.1", ok));

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();

const org = await Organization.create({ name: "Delta HQ E2E", baseCurrency: "AED" });
const other = await Organization.create({ name: "Delta Bangalore E2E", baseCurrency: "INR" });
const ORG = String(org._id), OTHER = String(other._id);
const role = await Role.create({ organizationId: org._id, key: "accounts", name: "Accounts", permissions: ["commission:read", "commission:write"] });
const person = (name: string, extra: Record<string, unknown> = {}) => User.create({
  name, email: `${name.toLowerCase().replace(/\s/g, ".")}@e2e-crmcomm.test`, passwordHash: "x", status: "active",
  memberships: [{ organizationId: org._id, roleId: role._id, status: "active", ...extra }, { organizationId: other._id, roleId: role._id, status: "active", ...extra }],
});
const mona = await person("Mona Manager", { isManager: true });
const asha = await person("Asha Accounts");
const MONA = String(mona._id), ASHA = String(asha._id);
const M = "2026-10";
const approve = (by: string, who: string, crm = "delta", note = "") => svc.approveCrmCommission(ORG, by, false, approveCrmCommissionSchema.parse({ crm, month: M, userId: who, note }));
const receiptKey = (o = ORG) => `expenses/${o}/uploads/1-abc-receipt.pdf`;
const pay = (who: string, o = ORG, extra: Record<string, unknown> = {}) => svc.payCrmCommission(o, ASHA, payCrmCommissionSchema.parse({
  crm: "delta", month: M, userId: who, paidOn: "2026-11-02", paymentMethod: "bank_transfer", reference: "TRX-1", category: "sales_commission",
  receipt: { name: "receipt.pdf", key: receiptKey(o), size: 1234, mimeType: "application/pdf" }, ...extra,
}));

// The sales' invoices here (2026-10-26, the collected amount): S1 part paid; S2 in full; another organization's S1,
// sold by another CRM, which isn't Ria's; S3 voided.
await mongoose.connection.db!.collection("invoices").insertMany([
  { organizationId: org._id, invoiceNumber: "IN-S1", status: "partially_paid", totalMinor: 300000, amountPaidMinor: 200000, enrolment: { crm: "delta" } },
  { organizationId: other._id, invoiceNumber: "IN-S1", status: "paid", totalMinor: 999900, amountPaidMinor: 999900, enrolment: { crm: "remote" } },
  { organizationId: org._id, invoiceNumber: "IN-S2", status: "paid", totalMinor: 150000, amountPaidMinor: 150000, enrolment: { crm: "delta" } },
  { organizationId: org._id, invoiceNumber: "IN-S3", status: "voided", totalMinor: 50000, amountPaidMinor: 50000, enrolment: { crm: "delta" } },
]);

/* ── 1 ── */
step("1. The month, per CRM and person");
let view = await svc.crmCommissionMonth(ORG, ASHA, ["commission:read", "commission:write"], false, M);
const delta = view.crms.find((c) => c.code === "delta")!;
check("each CRM, its people: My Pay's payable (minor units) with the earned figure, %, level — earned state",
  delta.people.map((p) => [p.name, p.amountMinor, p.earnedMinor, p.percent, p.level, p.state]).join("|") === "Ria,60000,120000,50,Level 2,earned|Abrar,12000,12000,100,Level 1,earned|Lena,0,30000,0,Base,earned"
  && delta.totalMinor === 72000 && delta.earnedTotalMinor === 132000 && delta.payError === null, j(delta.people));
check("…with the sales behind them and what is still on its way", delta.people[0]!.lines.length === 2 && delta.pending.progress === 1);
const riaNow = delta.people.find((p) => p.name === "Ria")!;
check("collected: each sale's invoice here, the one this CRM sold — Ria 2,000 of 3,000 + 1,500", riaNow.collectedMinor === 350000
  && riaNow.lines.map((l) => [l.invoiceNumber, l.collectedMinor, l.feeMinor].join(":")).join("|") === "IN-S1:200000:300000|IN-S2:150000:150000", j(riaNow.lines));
check("…a voided invoice collects nothing; the CRM's total counts each sale once (Abrar's S1 / S2 are Ria's)",
  delta.people.find((p) => p.name === "Lena")!.collectedMinor === 0 && delta.people.find((p) => p.name === "Lena")!.lines[0]!.collectedMinor === null
  && delta.collectedTotalMinor === 350000, j({ total: delta.collectedTotalMinor }));
check("a CRM that can't be read says so", view.crms.find((c) => c.code === "banglore")?.error === "No database URI configured");
check("asked of Root with finance's secret and the month", root.hits.at(-1)?.signed === true && root.hits.at(-1)?.month === M, j(root.hits.at(-1)));
check("Asha: pays, doesn't approve; Mona: approves", !view.me.canApprove && view.me.canPay && (await svc.crmCommissionMonth(ORG, MONA, ["commission:read"], false, M)).me.canApprove);

/* ── 2 ── */
step("2. A manager approves");
check("not a manager: refused", /tagged Manager/.test(await refusal(approve(ASHA, RIA))));
check("paying before an approval: refused", /manager has to approve it first/.test(await refusal(pay(RIA))));
await approve(MONA, RIA, "delta", "October, all good");
view = await svc.crmCommissionMonth(ORG, ASHA, ["commission:write"], false, M);
let ria = view.crms.find((c) => c.code === "delta")!.people.find((p) => p.userId === RIA)!;
check("approved: frozen at the 600 payable (not the 1,200 earned), by Mona, with her note", ria.state === "approved" && ria.payout?.amountMinor === 60000 && ria.payout.approvedByName === "Mona Manager" && ria.payout.approvalNote === "October, all good", j(ria.payout));
check("nothing payable at her level (0% of 300): can't be approved", /Nothing is payable to Lena/.test(await refusal(approve(MONA, LENA))));
check("a CRM whose My Pay figures are missing: can't be approved, saying why", /My Pay figures aren't available/.test(await refusal(approve(MONA, NUSRA, "remote"))));
const remoteView = view.crms.find((c) => c.code === "remote")!;
check("…and the page says so: payable unknown", !remoteView.people[0]!.payableKnown && /REMOTE_API_URL/.test(remoteView.payError ?? ""), j(remoteView));
check("only once", /already approved/.test(await refusal(approve(MONA, RIA))));
check("someone with nothing counted: refused", /Nothing is counted/.test(await refusal(approve(MONA, new Types.ObjectId().toString()))));
check("a super admin approves too", !!(await svc.approveCrmCommission(ORG, ASHA, true, approveCrmCommissionSchema.parse({ crm: "draw", month: M, userId: IRFANA }))).approved);
await svc.revokeCrmCommission(ORG, MONA, false, { crm: "draw", month: M, userId: IRFANA });
check("taken back before it is paid: earned again", (await svc.crmCommissionMonth(ORG, ASHA, [], false, M)).crms.find((c) => c.code === "draw")!.people[0]!.state === "earned");

/* ── 3 ── */
step("3. Accounts pay it, with the receipt");
check("a receipt not uploaded here: refused", /Upload the receipt here first/.test(await refusal(pay(RIA, ORG, { receipt: { name: "r.pdf", key: "https://evil.example/r.pdf" } }))));
check("…nor another organization's upload", /Upload the receipt here first/.test(await refusal(pay(RIA, ORG, { receipt: { name: "r.pdf", key: receiptKey(OTHER) } }))));
check("no receipt at all: refused by the form", !payCrmCommissionSchema.safeParse({ crm: "delta", month: M, userId: RIA, paidOn: "2026-11-02", paymentMethod: "cash", category: "sales_commission" }).success);
const paid = await pay(RIA);
const exp = await Expense.findById(paid.expense.id).lean<any>();
check("one paid expense for the approved 600, the receipt on it", exp?.status === "approved" && !!exp.paidOn && exp.totalMinor === 60000 && exp.attachments?.[0]?.key === receiptKey() && /Sales commission — Ria \(Sales CRM, 2026-10\)/.test(exp.description), j(exp));
check("…dated and referenced as paid, approved by the manager", new Date(exp.paidOn).toISOString().startsWith("2026-11-02") && exp.reference === "TRX-1" && exp.approvedByName === "Mona Manager");
view = await svc.crmCommissionMonth(ORG, ASHA, [], false, M);
ria = view.crms.find((c) => c.code === "delta")!.people.find((p) => p.userId === RIA)!;
check("paid: by whom, when, how, the expense and the receipt", ria.state === "paid" && ria.payout?.paidByName === "Asha Accounts" && ria.payout.paidOn === "2026-11-02" && ria.payout.expense?.expenseNumber === exp.expenseNumber && !!ria.payout.receipt?.url, j(ria.payout));
check("never twice", /paid already/.test(await refusal(pay(RIA))));
check("…not from another organization either", /paid already/.test(await refusal(pay(RIA, OTHER))));
check("a paid one can't be taken back", /not waiting to be paid/.test(await refusal(svc.revokeCrmCommission(ORG, MONA, false, { crm: "delta", month: M, userId: RIA }))));
check("one expense in all", (await Expense.countDocuments({ description: "Sales commission — Ria (Sales CRM, 2026-10)" })) === 1);

/* ── 4 ── */
step("4. The CRM's figure moves after approval");
await approve(MONA, ABRAR);
root.crms[0].people[1].amount = 70; // a sale reversed
root.crms[0].people[1].payable = 70;
view = await svc.crmCommissionMonth(ORG, ASHA, [], false, M);
const abrar = view.crms.find((c) => c.code === "delta")!.people.find((p) => p.userId === ABRAR)!;
check("flagged: approved at 120, the CRM's My Pay says 70 payable now", abrar.changed && abrar.payout?.amountMinor === 12000 && abrar.amountMinor === 7000, j(abrar));

/* ── 4b ── */
step("4b. The CRMs read their payouts back, for My Pay");
const back = await svc.payoutsForCrm("delta", M);
const backRia = back.find((x) => x.userId === RIA), backAbrar = back.find((x) => x.userId === ABRAR);
check("Ria: paid 600 on 2 November by bank transfer, TRX-1", backRia?.state === "paid" && backRia.amount === 600 && backRia.paidOn === "2026-11-02" && backRia.paymentMethod === "bank_transfer" && backRia.reference === "TRX-1", j(backRia));
check("Abrar: approved 120 by Mona, not paid", backAbrar?.state === "approved" && backAbrar.amount === 120 && backAbrar.approvedByName === "Mona Manager" && !backAbrar.paidOn, j(backAbrar));
check("another CRM's month: only its own", (await svc.payoutsForCrm("draw", M)).length === 0);
root.crms[0].people = root.crms[0].people.filter((p: any) => p.userId !== RIA);
view = await svc.crmCommissionMonth(ORG, ASHA, [], false, M);
const gone = view.crms.find((c) => c.code === "delta")!.people.find((p) => p.userId === RIA);
check("a paid one whose sales all went: still shown, flagged", gone?.state === "paid" && gone.changed && gone.amountMinor === 0, j(gone));

/* ── 5 ── */
step("5. Root not set up, out of date, down");
root.mode = "old";
check("out of date: says it needs updating", /needs updating/.test(await refusal(svc.crmCommissionMonth(ORG, ASHA, [], false, M))));
root.mode = "ok";
const saved = env.ROOT_ERP_SECRET;
(env as any).ROOT_ERP_SECRET = "wrong";
check("a wrong secret: says Root could not give it", /could not give/.test(await refusal(svc.crmCommissionMonth(ORG, ASHA, [], false, M))));
(env as any).ROOT_ERP_SECRET = "";
check("not set up: says so", /not configured/.test(await refusal(svc.crmCommissionMonth(ORG, ASHA, [], false, M))));
(env as any).ROOT_ERP_SECRET = saved;
server.close();
check("down: says it could not be reached", /could not be reached/.test(await refusal(svc.crmCommissionMonth(ORG, ASHA, [], false, M))));

console.log(`\n${checks - failures}/${checks} passed`);
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
