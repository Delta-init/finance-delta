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
 *   - collected is in the CRM's currency (2026-10-31): a Bangalore sale's rupee invoice at the CRM's rate, found by
 *     its student when its number is another organization's too; with no rate, the rupees shown apart, not added in.
 *   - paid in full first (2026-10-31): commission on a sale the client is still paying for shows as waiting, not
 *     earned, and can't be approved.
 *   - collected this month (payments dated in it) beside collected in all and the fee; the sale's salesperson and team
 *     leader from Root; a sale's invoice whole for the pop-up, from any organization, only if a CRM raised it.
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
  { organizationId: org._id, invoiceNumber: "IN-S1", status: "partial", totalMinor: 300000, amountPaidMinor: 200000, enrolment: { crm: "delta" } },
  { organizationId: other._id, invoiceNumber: "IN-S1", status: "paid", totalMinor: 999900, amountPaidMinor: 999900, enrolment: { crm: "remote" } },
  { organizationId: org._id, invoiceNumber: "IN-S2", status: "paid", totalMinor: 150000, amountPaidMinor: 150000, enrolment: { crm: "delta" } },
  // "void" — finance's own word for a cancelled invoice (the first version looked for "voided" and counted these).
  { organizationId: org._id, invoiceNumber: "IN-S3", status: "void", totalMinor: 50000, amountPaidMinor: 50000, enrolment: { crm: "delta" } },
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

/* ── 6 ── */
step("6. A Bangalore sale's rupees, in the CRM's AED (2026-10-31)");
const YAMI = new Types.ObjectId().toString(), STU = new Types.ObjectId().toString();
const bangaloreLine = { ...line("sales", 200, "S9"), studentId: STU };
root.crms[0].inrPerAed = 22.75;
root.crms[0].people.push({ userId: YAMI, name: "Yami", roles: ["sales"], amount: 400, payable: 400, percent: 100, level: "Level 1", sales: 2,
  lines: [{ ...line("sales", 200, "S2") }, bangaloreLine] });
await mongoose.connection.db!.collection("invoices").insertMany([
  // The Dubai organization's own IN-S9, another student's — the number repeats across organizations.
  { organizationId: org._id, invoiceNumber: "IN-S9", status: "paid", currency: "AED", totalMinor: 100000, amountPaidMinor: 100000, enrolment: { crm: "delta" }, external: { source: "crm", externalId: new Types.ObjectId().toString() } },
  { organizationId: other._id, invoiceNumber: "IN-S9", status: "paid", currency: "INR", totalMinor: 5737500, amountPaidMinor: 5737500, enrolment: { crm: "delta", academy: "bangalore" }, external: { source: "crm", externalId: STU } },
]);
view = await svc.crmCommissionMonth(ORG, ASHA, [], false, M);
let yami = view.crms.find((c) => c.code === "delta")!.people.find((p) => p.userId === YAMI)!;
let s9 = yami.lines.find((l) => l.invoiceNumber === "IN-S9")!;
check("found by its student, not the other organization's IN-S9: INR 57,375 ≈ AED 2,521.98 at 22.75",
  s9.collectedMinor === 252198 && s9.feeMinor === 252198 && s9.invoiceCurrency === "INR" && s9.invoiceCollectedMinor === 5737500, j(s9));
check("her collected: AED 1,500 + AED 2,521.98 — not AED 58,875", yami.collectedMinor === 402198 && (yami.collectedOther ?? []).length === 0, j({ c: yami.collectedMinor, o: yami.collectedOther }));
check("an AED invoice stays as it is", yami.lines.find((l) => l.invoiceNumber === "IN-S2")!.collectedMinor === 150000 && !yami.lines.find((l) => l.invoiceNumber === "IN-S2")!.invoiceCurrency);
check("the CRM's total: S1 (Abrar's line), S2 once, the rupees in AED", view.crms.find((c) => c.code === "delta")!.collectedTotalMinor === 200000 + 150000 + 252198, j(view.crms.find((c) => c.code === "delta")!.collectedTotalMinor));
delete root.crms[0].inrPerAed;
view = await svc.crmCommissionMonth(ORG, ASHA, [], false, M);
yami = view.crms.find((c) => c.code === "delta")!.people.find((p) => p.userId === YAMI)!;
s9 = yami.lines.find((l) => l.invoiceNumber === "IN-S9")!;
check("no rate from Root: the rupees shown apart, never added in", yami.collectedMinor === 150000 && JSON.stringify(yami.collectedOther) === JSON.stringify([{ currency: "INR", amountMinor: 5737500 }])
  && s9.collectedMinor === null && s9.invoiceCollectedMinor === 5737500
  && JSON.stringify(view.crms.find((c) => c.code === "delta")!.collectedOther) === JSON.stringify([{ currency: "INR", amountMinor: 5737500 }]), j({ yami, s9 }));
root.crms[0].people = root.crms[0].people.filter((p: any) => p.userId !== YAMI);

/* ── 7 ── */
step("7. Paid in full first — commission waiting for the client (2026-10-31)");
const WAFA = new Types.ObjectId().toString();
root.crms[0].waitingTotal = 230;
root.crms[0].people.push({ userId: WAFA, name: "Wafa", roles: ["sales"], amount: 0, waiting: 230, payable: 0, percent: 100, level: "Level 1", sales: 1,
  lines: [{ ...line("sales", 0, "S10"), waiting: 230, paidInFullAt: null }] });
view = await svc.crmCommissionMonth(ORG, ASHA, [], false, M);
const d7 = view.crms.find((c) => c.code === "delta")!;
const wafa = d7.people.find((p) => p.userId === WAFA)!;
check("a part-paid sale: nothing earned, all 230 waiting — on the person, the line and the CRM",
  wafa.earnedMinor === 0 && wafa.waitingMinor === 23000 && wafa.lines[0]!.waiting === 230 && wafa.lines[0]!.paidInFullAt === null && d7.waitingTotalMinor === 23000, j({ wafa, w: d7.waitingTotalMinor }));
check("…nothing to approve until it is paid in full", /Nothing is payable/.test(await refusal(approve(MONA, WAFA))));
check("an older Root (no waiting figures): nothing waiting", view.crms.find((c) => c.code === "draw")!.waitingTotalMinor === 0
  && view.crms.find((c) => c.code === "draw")!.people.every((p) => p.waitingMinor === 0));
root.crms[0].people = root.crms[0].people.filter((p: any) => p.userId !== WAFA);
delete root.crms[0].waitingTotal;

/* ── 8 ── */
step("8. This month's collected, the people on a sale, the invoice pop-up (2026-10-31)");
const HANA = new Types.ObjectId().toString(), STU8 = new Types.ObjectId().toString();
const inv8 = new Types.ObjectId();
await mongoose.connection.db!.collection("invoices").insertMany([
  { _id: inv8, organizationId: other._id, invoiceNumber: "IN-S11", status: "partial", currency: "AED", totalMinor: 225000, amountPaidMinor: 150000, balanceMinor: 75000,
    customerId: new Types.ObjectId(), salespersonId: new Types.ObjectId(), salespersonName: "Jalwa Raiser", createdAt: new Date(), updatedAt: new Date(), taxBreakdown: [], tagIds: [], subtotalMinor: 225000, taxTotalMinor: 0, discountTotalMinor: 0, customerName: "Client Eleven", issueDate: new Date("2026-09-20"), dueDate: new Date("2026-10-20"), lineItems: [], enrolment: { crm: "delta" }, external: { source: "crm", externalId: STU8 },
    payments: [{ amountMinor: 50000, paidOn: new Date("2026-09-20T08:00:00Z"), method: "cash" }, { amountMinor: 100000, paidOn: new Date("2026-10-10T08:00:00Z"), method: "card" }] },
  // Not a CRM's: never shown through the commission page.
  { _id: new Types.ObjectId("6a0000000000000000000abc"), organizationId: org._id, invoiceNumber: "IN-OWN", status: "paid", currency: "AED", totalMinor: 1000, amountPaidMinor: 1000, customerName: "Walk-in", lineItems: [], payments: [] },
]);
root.crms[0].people.push({ userId: HANA, name: "Hana", roles: ["tl"], amount: 85, payable: 85, percent: 100, level: "Level 1", sales: 1,
  lines: [{ ...line("tl", 85, "S11"), studentId: STU8, salesName: "Ria", tlName: "Hana", waiting: 0, paidInFullAt: "2026-10-10T08:00:00.000Z" }] });
view = await svc.crmCommissionMonth(ORG, ASHA, [], false, M);
const hana = view.crms.find((c) => c.code === "delta")!.people.find((p) => p.userId === HANA)!;
const l8 = hana.lines[0]!;
check("the line: 1,000 collected this month (not September's 500), 1,500 in all of 2,250; its invoice and organization",
  l8.monthCollectedMinor === 100000 && l8.collectedMinor === 150000 && l8.feeMinor === 225000 && l8.invoiceId === String(inv8) && l8.invoiceOrgId === OTHER, j(l8));
check("…the person: this month's 1,000, of 2,250 fees", hana.monthCollectedMinor === 100000 && hana.feesMinor === 225000 && hana.collectedMinor === 150000, j({ m: hana.monthCollectedMinor, f: hana.feesMinor }));
check("…who sold it and their team leader, from Root", l8.salesName === "Ria" && l8.tlName === "Hana", j(l8));
check("…who raised its invoice here", l8.raisedByName === "Jalwa Raiser", j(l8.raisedByName));
const other8 = await svc.crmCommissionMonth(ORG, ASHA, [], false, "2026-09");
check("September: the same sale shows September's 500 as that month's", other8.crms.find((c) => c.code === "delta")!.people.find((p) => p.userId === HANA)?.lines[0]?.monthCollectedMinor === 50000);
const pop = await svc.commissionInvoice(String(inv8));
check("the pop-up: the invoice whole, from another organization, with its organization", pop.invoice.invoiceNumber === "IN-S11" && pop.invoice.payments.length === 2 && pop.orgId === OTHER && pop.orgName === "Delta Bangalore E2E", j({ n: pop.invoice.invoiceNumber, o: pop.orgName }));
check("…not an invoice no CRM raised, not a made-up id: not found", /not found/i.test(await refusal(svc.commissionInvoice("6a0000000000000000000abc"))) && /not found/i.test(await refusal(svc.commissionInvoice("nope"))));
root.crms[0].people = root.crms[0].people.filter((p: any) => p.userId !== HANA);

/* ── 9 ── */
step("9. Paid in rupees, earned in rupees (2026-11-13)");
// Ina: one sale a quarter in rupees (AED 750 + INR 5,000 of 1,000 / INR 20,000), on a level paying half. Omar: all of
// his in rupees — nothing in AED at all.
const INA = new Types.ObjectId().toString(), OMAR = new Types.ObjectId().toString();
const inrLine = (role: string, amount: number, amountInr: number, student: string, rupeeShare: number, plan: number, planInr: number) =>
  ({ ...line(role, amount, student), amountInr, rupeeShare, plan, planInr });
root.crms[0].people.push(
  { userId: INA, name: "Ina", roles: ["sales"], amount: 750, payable: 375, percent: 50, level: "Level 2", sales: 1, amountInr: 5000, payableInr: 2500, lines: [inrLine("sales", 750, 5000, "S20", 0.25, 1000, 20000)] },
  { userId: OMAR, name: "Omar", roles: ["sales"], amount: 0, payable: 0, percent: 100, level: "Level 1", sales: 1, amountInr: 8000, payableInr: 8000, lines: [inrLine("sales", 0, 8000, "S21", 1, 400, 8000)] },
);
root.crms[0].totalInr = 13000;
root.crms[0].payableInrTotal = 10500;
const { BankAccount } = await import("../modules/banking/bank-account.model");
const { BankTransaction } = await import("../modules/banking/bank-transaction.model");
const acct = (name: string, currency: string) => BankAccount.create({ organizationId: org._id, accountName: name, accountType: "current", currency, openingDate: new Date("2026-01-01") });
const inrAcc = await acct("Rupee account", "INR"), aedAcc = await acct("Dirham account", "AED");
const deltaNow = async () => (await svc.crmCommissionMonth(ORG, ASHA, ["commission:write"], false, M)).crms.find((c) => c.code === "delta")!;
let delta9 = await deltaNow();
let ina = delta9.people.find((p) => p.userId === INA)!, omar = delta9.people.find((p) => p.userId === OMAR)!;
check("the page: Ina's AED 375 payable with INR 2,500 beside it — earned 750 and INR 5,000, each line's split",
  ina.amountMinor === 37500 && ina.earnedMinor === 75000 && ina.inr?.amountMinor === 250000 && ina.inr.earnedMinor === 500000 && ina.inr.state === "earned"
  && ina.lines[0]?.amountInr === 5000 && ina.lines[0]?.rupeeShare === 0.25 && ina.lines[0]?.planInr === 20000, j(ina));
check("…the CRM's rupee totals apart from its AED ones", delta9.inrTotalMinor === 1050000 && delta9.inrEarnedTotalMinor === 1300000, j({ t: delta9.inrTotalMinor, e: delta9.inrEarnedTotalMinor }));
check("…somebody without rupees has no rupee part", delta9.people.find((p) => p.userId === ABRAR)?.inr === undefined);
await approve(MONA, INA);
delta9 = await deltaNow();
ina = delta9.people.find((p) => p.userId === INA)!;
check("approved in one go: the AED part frozen at 375, the rupee part at INR 2,500 — two payouts", ina.state === "approved" && ina.payout?.amountMinor === 37500
  && ina.inr?.state === "approved" && ina.inr.payout?.amountMinor === 250000, j({ a: ina.payout, i: ina.inr }));
check("…again: already approved", /already approved/.test(await refusal(approve(MONA, INA))));
await approve(MONA, OMAR);
omar = (await deltaNow()).people.find((p) => p.userId === OMAR)!;
check("all in rupees: nothing in AED to approve, the INR 8,000 approved", omar.state === "earned" && omar.payout === null && omar.inr?.state === "approved" && omar.inr.payout?.amountMinor === 800000, j(omar));
check("the rupee part needs its INR account", /INR account/.test(await refusal(pay(INA, ORG, { part: "inr" }))));
check("…not an AED one", /is in AED, this is in INR/.test(await refusal(pay(INA, ORG, { part: "inr", bankAccountId: String(aedAcc._id) }))));
const paidInr = await pay(INA, ORG, { part: "inr", bankAccountId: String(inrAcc._id), reference: "INR-1" });
const expInr = await Expense.findById(paidInr.expense.id).lean<any>();
check("paid: an expense in INR for the 2,500, out of the rupee account", expInr?.currency === "INR" && expInr.totalMinor === 250000 && String(expInr.bankAccountId) === String(inrAcc._id)
  && /the part earned in rupees/.test(expInr.description), j({ c: expInr?.currency, t: expInr?.totalMinor, d: expInr?.description, n: expInr?.bankNote }));
const inrOut = await BankTransaction.find({ accountId: inrAcc._id }).lean<any[]>();
check("…its money-out line in that account, nothing in the dirham one", inrOut.length === 1 && inrOut[0].amountMinor === -250000 && (await BankTransaction.countDocuments({ accountId: aedAcc._id })) === 0, j(inrOut));
ina = (await deltaNow()).people.find((p) => p.userId === INA)!;
check("the rupee part paid, the AED part still waiting to be paid", ina.inr?.state === "paid" && ina.inr.payout?.reference === "INR-1" && ina.state === "approved", j({ s: ina.state, i: ina.inr?.state }));
check("…never twice", /paid already/.test(await refusal(pay(INA, ORG, { part: "inr", bankAccountId: String(inrAcc._id) }))));
const paidAed = await pay(INA);
const expAed = await Expense.findById(paidAed.expense.id).lean<any>();
check("the AED part paid as ever: AED 375, its own expense", expAed?.currency === "AED" && expAed.totalMinor === 37500 && !/rupees/.test(expAed.description), j({ c: expAed?.currency, t: expAed?.totalMinor }));
await svc.revokeCrmCommission(ORG, MONA, false, { crm: "delta", month: M, userId: OMAR });
omar = (await deltaNow()).people.find((p) => p.userId === OMAR)!;
check("an approval taken back takes the rupee part back too", omar.inr?.state === "earned" && omar.inr.payout === null, j(omar.inr));
const back9 = await svc.payoutsForCrm("delta", M);
const backIna = back9.find((x) => x.userId === INA) as any;
check("the CRM reads one row a person: Ina's AED 375 paid, her rupee part on it; nobody twice", backIna?.amount === 375 && backIna.currency === "AED" && backIna.inr?.amount === 2500 && backIna.inr.state === "paid"
  && back9.filter((x) => x.userId === INA).length === 1 && !back9.some((x) => x.userId === OMAR), j(backIna));
root.crms[0].people.find((p: any) => p.userId === INA).payableInr = 2000;
ina = (await deltaNow()).people.find((p) => p.userId === INA)!;
check("the CRM's rupee figure moves after approval: flagged on the rupee part only", ina.inr?.changed === true && ina.changed === false, j({ i: ina.inr?.changed, a: ina.changed }));
root.crms[0].people = root.crms[0].people.filter((p: any) => p.userId !== INA && p.userId !== OMAR);
const gone9 = (await deltaNow()).people.find((p) => p.userId === INA);
check("both parts still shown once the sales are gone", gone9?.state === "paid" && gone9.inr?.state === "paid" && gone9.inr.changed, j(gone9));

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
