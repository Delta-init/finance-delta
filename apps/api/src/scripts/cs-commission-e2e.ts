/**
 * The CS Portal's commission in finance (2026-11-03), against a scratch database and a stand-in CS Portal
 * (run by scripts/cs-commission-e2e.sh):
 *
 *   1. a bonus month per CS: in AED at 3.67, a Bangalore team's CS in INR at 100 — waiting (with the broker admin
 *      there), ready (with finance; or released there by a Super Admin); totals per currency; who may approve and pay;
 *   2. approved by a manager only, only once the CS Portal is done with it: the CS Portal's Finance step done, the
 *      amount frozen; one already released there approved too; never twice;
 *   3. taken back before it's paid: the CS Portal's step undone (one a Super Admin released stays released there);
 *   4. paid with the receipt by an organization in the CS's currency: a paid expense (Mentor Commission); never twice;
 *   5. the CS Portal down or not yet updated: said plainly.
 */
import http from "node:http";
import mongoose from "mongoose";
import { approveCsCommissionSchema, payCsCommissionSchema, recordCsCommissionPaymentSchema } from "@delta/shared";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}
const SECRET = process.env.COMMISSION_S2S_SECRET ?? "";
const PORT = Number(new URL(process.env.COMMISSION_API_URL ?? "http://127.0.0.1:0").port);

const { Organization } = await import("../modules/organization/organization.model");
const { User } = await import("../modules/user/user.model");
const { Role } = await import("../modules/role/role.model");
const { Expense } = await import("../modules/expense/expense.model");
const { CsCommissionPayout } = await import("../modules/cs-commission/cs-commission-payout.model");
const svc = await import("../modules/cs-commission/cs-commission.service");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const j = (v: unknown) => JSON.stringify(v).slice(0, 400);
const refusal = async (p: Promise<unknown>) => p.then(() => "", (e: Error & { code?: string }) => `${e.code ?? ""} ${e.message}`);

/* ── A stand-in CS Portal: the period's people and their approval chain, as finance/csCommission.ts answers ── */
const MEERA = "65a000000000000000000001", BINDU = "65a000000000000000000002", KIRAN = "65a000000000000000000003", LINA = "65a000000000000000000004";
const stage = (status = "pending") => ({ status, by: "", at: null });
const credit = (id: string, usd: number) => ({ id, date: "2026-09-05T10:00:00.000Z", student: "Student", method: "bonus_with", level: 1, position: "Junior", percentage: 10, base_usd: usd * 10, amount_usd: usd, status: "accrued", txn_id: `TX-${id}`, initiator: "Someone" });
const portal = {
  mode: "ok" as "ok" | "old" | "down",
  asked: [] as Array<{ path: string; signed: boolean; body: any }>,
  people: [
    { recipient_id: MEERA, name: "Mentor Meera", email: "mentor.meera@e2e-cs.test", location: "dubai", total_usd: 100, credits: [credit("c1", 60), credit("c2", 40)],
      approval: { overall_status: "pending_finance_approval", broker: stage("approved"), academic: stage("approved"), finance: stage(), released_at: null, released_by: "", by_finance: false } },
    { recipient_id: BINDU, name: "Mentor Bindu", email: "mentor.bindu@e2e-cs.test", location: "bangalore", total_usd: 40, credits: [credit("c3", 40)],
      approval: { overall_status: "released", broker: stage("approved"), academic: stage("approved"), finance: stage("approved"), released_at: "2026-10-03T09:00:00.000Z", released_by: "Super Admin", by_finance: false } },
    { recipient_id: KIRAN, name: "Mentor Kiran", email: "mentor.kiran@e2e-cs.test", location: "dubai", total_usd: 25, credits: [credit("c4", 25)],
      approval: { overall_status: "pending_broker_approval", broker: stage(), academic: stage(), finance: stage(), released_at: null, released_by: "", by_finance: false } },
    { recipient_id: LINA, name: "Mentor Lina", email: "mentor.lina@e2e-cs.test", location: "dubai", total_usd: 10, credits: [credit("c5", 10)],
      approval: { overall_status: "pending_academic_approval", broker: stage("approved"), academic: stage(), finance: stage(), released_at: null, released_by: "", by_finance: false } },
  ] as any[],
};
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : {};
    const url = new URL(req.url ?? "/", "http://x");
    const signed = req.headers["x-finance-secret"] === SECRET;
    portal.asked.push({ path: url.pathname, signed, body });
    const send = (code: number, b: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    if (portal.mode === "old" || !url.pathname.startsWith("/api/v1/integrations/finance/cs-commission")) return send(404, { error: "Not found" });
    if (portal.mode === "down") return send(500, { success: false, error: { code: "BOOM", message: "Its database can't be reached" } });
    if (!signed) return send(401, { success: false, error: { code: "UNAUTHORISED", message: "Bad secret" } });
    const who = portal.people.find((p) => p.recipient_id === body.recipient_id);
    const refuse = (code: string, message: string) => send(409, { success: false, error: { code, message } });
    if (url.pathname.endsWith("/cs-commission")) return send(200, { success: true, data: { kind: body.kind, period: body.period, ended: true, people: portal.people } });
    if (!who) return refuse("NOTHING_TO_APPROVE", "No commission for this person in the period.");
    const answer = (already: boolean, override = false) => send(200, { success: true, data: { already, total_usd: who.total_usd, credit_ids: who.credits.map((c: any) => c.id), name: who.name, email: who.email, location: who.location, finance_override: override } });
    if (url.pathname.endsWith("/approve")) {
      if (who.approval.overall_status === "released") return answer(true, !!who.approval.finance_override);
      if (who.approval.overall_status !== "pending_finance_approval") {
        // Before the broker admin and academic head (2026-11-06): with force and a reason only, as the CS Portal does.
        if (!body.force) return refuse("NOT_READY", "Waiting for the broker admin in the CS Portal.");
        if (!body.reason) return send(400, { success: false, error: { code: "VALIDATION_ERROR", message: "Say why it is paid before the broker admin has approved it." } });
        who.approval = { ...who.approval, from: who.approval.overall_status, overall_status: "released", by_finance: true, released_by: `${body.by} (Delta finance)`, finance_override: true, override_reason: body.reason };
        return answer(false, true);
      }
      who.approval = { ...who.approval, overall_status: "released", by_finance: true, released_by: `${body.by} (Delta finance)` };
      return answer(false);
    }
    if (url.pathname.endsWith("/unapprove")) {
      if (!who.approval.by_finance) return refuse("NOT_FINANCES", "Released in the CS Portal, not by Delta finance — undo it there.");
      const back = who.approval.finance_override ? who.approval.from : "pending_finance_approval";
      who.approval = { ...who.approval, overall_status: back, by_finance: false, released_by: "", finance_override: false, override_reason: "", from: undefined };
      return send(200, { success: true, data: { undone: true } });
    }
    send(404, { error: "Not found" });
  });
});
await new Promise<void>((ok) => server.listen(PORT, "127.0.0.1", ok));

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();

const org = await Organization.create({ name: "Delta HQ E2E", baseCurrency: "AED" });
const blr = await Organization.create({ name: "Delta Bangalore E2E", baseCurrency: "INR" });
const ORG = String(org._id), BLR = String(blr._id);
const role = await Role.create({ organizationId: org._id, key: "accounts", name: "Accounts", permissions: ["commission:read", "commission:write"] });
const person = (name: string, extra: Record<string, unknown> = {}) => User.create({
  name, email: `${name.toLowerCase().replace(/\s/g, ".")}@e2e-cscomm.test`, passwordHash: "x", status: "active",
  memberships: [{ organizationId: org._id, roleId: role._id, status: "active", ...extra }, { organizationId: blr._id, roleId: role._id, status: "active", ...extra }],
});
const MONA = String((await person("Mona Manager", { isManager: true }))._id);
const ASHA = String((await person("Asha Accounts"))._id);
const P = "2026-09";
const period = (by = ASHA) => svc.csCommissionPeriod(ORG, by, ["commission:read", "commission:write"], false, "bonus", P);
const approve = (by: string, who: string) => svc.approveCsCommission(ORG, by, false, approveCsCommissionSchema.parse({ kind: "bonus", period: P, recipientId: who, note: "September, checked" }));
const revoke = (by: string, who: string) => svc.revokeCsCommission(ORG, by, false, { kind: "bonus", period: P, recipientId: who });
const receiptKey = (o = ORG) => `expenses/${o}/uploads/1-abc-receipt.pdf`;
const pay = (who: string, o = ORG) => svc.payCsCommission(o, ASHA, payCsCommissionSchema.parse({
  kind: "bonus", period: P, recipientId: who, paidOn: "2026-11-03", paymentMethod: "bank_transfer", reference: "TRX-CS", category: "sales_commission",
  receipt: { name: "receipt.pdf", key: receiptKey(o), size: 1234, mimeType: "application/pdf" },
}));
const row = (v: Awaited<ReturnType<typeof period>>, id: string) => v.people.find((p) => p.recipientId === id)!;

step("1. A bonus month, per CS");
let v = await period();
check("asked the CS Portal with finance's secret, for September's bonus", portal.asked.at(-1)?.signed === true && portal.asked.at(-1)?.body?.kind === "bonus" && portal.asked.at(-1)?.body?.period === P);
check("Meera: USD 100 → AED 367.00, ready (with finance), her two credits", row(v, MEERA).currency === "AED" && row(v, MEERA).amountMinor === 36700 && row(v, MEERA).state === "ready" && row(v, MEERA).credits.length === 2, j(row(v, MEERA)));
check("Bindu, a Bangalore team's: USD 40 → INR 4,000.00, ready (a Super Admin released it there)", row(v, BINDU).currency === "INR" && row(v, BINDU).amountMinor === 400000 && row(v, BINDU).state === "ready", j(row(v, BINDU)));
check("Kiran: still with the broker admin — waiting", row(v, KIRAN).state === "waiting" && row(v, KIRAN).approval.overall === "pending_broker_approval");
const aed = v.totals.find((t) => t.currency === "AED"), inr = v.totals.find((t) => t.currency === "INR");
check("totals per currency: AED 495.45 (367 + 91.75 + 36.70), INR 4,000", aed?.amountMinor === 49545 && inr?.amountMinor === 400000, j(v.totals));
check("Asha pays, doesn't approve; Mona approves", !v.canApprove && v.canPay && (await period(MONA)).canApprove);

step("2. Approved");
check("not a manager: refused", /tagged Manager/.test(await refusal(approve(ASHA, MEERA))));
check("Kiran, still with the broker admin there: refused, saying so", /broker admin/.test(await refusal(approve(MONA, KIRAN))));
const ok = await approve(MONA, MEERA);
v = await period();
check("Meera approved: the CS Portal's Finance step done by Mona", ok.approved && portal.asked.some((a) => a.path.endsWith("/approve") && a.body?.recipient_id === MEERA && a.body?.by === "Mona Manager")
  && portal.people[0].approval.overall_status === "released");
check("…frozen at AED 367.00, by Mona, with her note", row(v, MEERA).state === "approved" && row(v, MEERA).payout?.amountMinor === 36700 && row(v, MEERA).payout?.approvedByName === "Mona Manager"
  && row(v, MEERA).payout?.approvalNote === "September, checked" && row(v, MEERA).payout?.amountUsd === 100, j(row(v, MEERA).payout));
check("never twice", /already approved/.test(await refusal(approve(MONA, MEERA))));
const b = await approve(MONA, BINDU);
v = await period();
check("Bindu, released there already: approved here too, INR 4,000", b.approved && b.alreadyReleased === true && row(v, BINDU).payout?.amountMinor === 400000 && row(v, BINDU).payout?.currency === "INR", j(b));

step("3. Taken back before it is paid");
await revoke(MONA, MEERA);
v = await period();
check("Meera: back to ready here, and with finance there again", row(v, MEERA).state === "ready" && !row(v, MEERA).payout && portal.people[0].approval.overall_status === "pending_finance_approval");
await revoke(MONA, BINDU);
check("Bindu: our approval gone; the Super Admin's release there stays", (await period()).people.find((p) => p.recipientId === BINDU)!.state === "ready" && portal.people[1].approval.overall_status === "released");
check("taken back when not approved: refused", /not waiting to be paid/.test(await refusal(revoke(MONA, MEERA))));
await approve(MONA, MEERA);
await approve(MONA, BINDU);

step("4. Paid with the receipt");
check("Meera's AED commission from the INR organization: refused", /in AED/.test(await refusal(pay(MEERA, BLR))));
check("a receipt not uploaded here: refused", /Upload the receipt here first/.test(await refusal(svc.payCsCommission(ORG, ASHA, payCsCommissionSchema.parse({
  kind: "bonus", period: P, recipientId: MEERA, paidOn: "2026-11-03", paymentMethod: "cash", category: "sales_commission", receipt: { name: "r.pdf", key: "https://evil.example/r.pdf" },
})))));
const paid = await pay(MEERA);
const exp = await Expense.findById(paid.expense.id).lean<any>();
check("one paid expense for AED 367.00, the receipt on it, Mentor Commission", exp?.status === "approved" && exp.totalMinor === 36700 && exp.currency === "AED"
  && exp.attachments?.[0]?.key === receiptKey() && /CS commission — Mentor Meera \(Bonus, September 2026\)/.test(exp.description) && exp.subcategory === "mentor_commission", j(exp));
v = await period();
check("paid: by whom, when, the expense and the receipt", row(v, MEERA).state === "paid" && row(v, MEERA).payout?.paidByName === "Asha Accounts" && row(v, MEERA).payout?.paidOn === "2026-11-03"
  && row(v, MEERA).payout?.expense?.expenseNumber === exp.expenseNumber && !!row(v, MEERA).payout?.receipt?.url, j(row(v, MEERA).payout));
check("never twice; not taken back once paid", /paid already/.test(await refusal(pay(MEERA))) && /not waiting to be paid/.test(await refusal(revoke(MONA, MEERA))));
check("Bindu's INR commission from the AED organization: refused", /in INR/.test(await refusal(pay(BINDU))));
const bp = await pay(BINDU, BLR);
const bexp = await Expense.findById(bp.expense.id).lean<any>();
check("…from the Bangalore organization: INR 4,000.00", bexp?.currency === "INR" && bexp.totalMinor === 400000 && String(bexp.organizationId) === BLR, j(bexp));
v = await period();
check("totals: what is paid of each currency", v.totals.find((t) => t.currency === "AED")?.paidMinor === 36700 && v.totals.find((t) => t.currency === "INR")?.paidMinor === 400000, j(v.totals));

step("4b. Record payment: approved and paid in one step — before the CS Portal's approvals too (2026-11-06)");
const record = (by: string, who: string, extra: Record<string, unknown> = {}) => svc.recordCsCommissionPayment(ORG, by, false, recordCsCommissionPaymentSchema.parse({
  kind: "bonus", period: P, recipientId: who, paidOn: "2026-11-06", paymentMethod: "cash", reference: "CASH-CS", category: "sales_commission",
  receipt: { name: "receipt.pdf", key: receiptKey(), size: 1234, mimeType: "application/pdf" }, ...extra,
}));
check("not a manager: refused — it approves too", /tagged Manager/.test(await refusal(record(ASHA, KIRAN, { reason: "Leaving" }))));
check("Kiran, still with the broker admin, no reason: refused, asking why; nothing approved",
  /Say why/.test(await refusal(record(MONA, KIRAN))) && !(await CsCommissionPayout.exists({ recipientId: KIRAN })) && portal.people[2].approval.overall_status === "pending_broker_approval");
const rec = await record(MONA, KIRAN, { reason: "Leaving this week" });
const recExp = await Expense.findById(rec.expense.id).lean<any>();
check("with a reason: approved and paid — AED 91.75 cash, the receipt, Mentor Commission", rec.approved && recExp?.totalMinor === 9175 && recExp.paymentMethod === "cash"
  && recExp.attachments?.[0]?.key === receiptKey() && /Approved by Mona Manager — Leaving this week/.test(recExp.notes), j(recExp));
check("…the CS Portal released it as finance's, early, with the reason", portal.people[2].approval.overall_status === "released" && portal.people[2].approval.finance_override === true
  && portal.asked.some((a) => a.path.endsWith("/approve") && a.body?.recipient_id === KIRAN && a.body?.force === true && a.body?.reason === "Leaving this week"));
v = await period();
check("…the page: paid, before the CS Portal's approvals, and why", row(v, KIRAN).state === "paid" && row(v, KIRAN).payout?.beforePortal === true
  && row(v, KIRAN).payout?.approvalNote === "Leaving this week" && row(v, KIRAN).approval.override === true, j(row(v, KIRAN)));
check("…never twice", /paid already/.test(await refusal(record(MONA, KIRAN, { reason: "Again" }))));
const badReceipt = await refusal(record(MONA, LINA, { reason: "Early", receipt: { name: "r.pdf", key: "https://evil.example/r.pdf" } }));
check("paying fails after approving (a receipt not uploaded here): refused, and the approval taken back — here and in the CS Portal",
  /Upload the receipt here first/.test(badReceipt) && !(await CsCommissionPayout.exists({ recipientId: LINA })) && portal.people[3].approval.overall_status === "pending_academic_approval"
  && !portal.people[3].approval.finance_override, `${badReceipt} ${j(portal.people[3].approval)}`);

step("5. The CS Portal down, or not yet updated");
portal.mode = "down";
check("down: said plainly", /UNAVAILABLE.*database can't be reached/.test(await refusal(period())));
portal.mode = "old";
check("not yet updated: said plainly", /needs updating/.test(await refusal(period())));

server.close();
await mongoose.disconnect();
console.log(`\n${failures ? "\x1b[31m" : "\x1b[32m"}${checks - failures}/${checks} checks passed\x1b[0m`);
process.exit(failures ? 1 : 0);
