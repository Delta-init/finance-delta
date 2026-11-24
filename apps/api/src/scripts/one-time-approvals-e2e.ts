/**
 * One-time payments on the Approvals page and the sidebar (the user, 2026-11-24: "it's already there but it's not in
 * the approvals and one time payment request area is not showing any count on the side bar"), against a stand-in
 * HRMS that answers like the real one (hrms-backend /integrations/one-time-payments/requests).
 *
 * What it proves:
 *   - the summary: a "one_time_payment" group counting every one waiting in every linked HRMS organisation, linking
 *     to /one-time-payments, in the employee's currency, and in the Approvals total (the sidebar's badges);
 *   - the list: waiting ones read live, who raised them in HR, found by the search; paid ones by their expense;
 *   - the count is kept two minutes, and asks HRMS again straight after Mark paid or Reject;
 *   - not counted for somebody without expense:approve;
 *   - HRMS not answering: the kind says it could not be read rather than a confident 0.
 *
 * Run through scripts/one-time-approvals-e2e.sh (throwaway mongod, no .env anywhere).
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
const { User } = await import("../modules/user/user.model");
const svc = await import("../modules/one-time-payments/one-time-payments.service");
const approvals = await import("../modules/approvals/approvals.service");
const { markOneTimePaidSchema } = await import("@delta/shared");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const j = (v: unknown) => JSON.stringify(v).slice(0, 500);

/* ── The stand-in HRMS: its queue per organisation ── */
const H = new Types.ObjectId().toString();   // Delta HQ's HRMS org
const H2 = new Types.ObjectId().toString();  // a second linked one, in rupees
const queue = new Map<string, Map<string, any>>([[H, new Map()], [H2, new Map()]]);
const stand = { down: false, reads: 0 };
const payment = (org: string, id: string, x: Record<string, unknown> = {}) => {
  queue.get(org)!.set(id, {
    _id: id, label: `Payment ${id}`, amount: 4000, month: "2026-11", notes: "",
    employee: { _id: `e-${id}`, name: "Sami Staff", employeeCode: "E0203", designation: "Legal advisor", currency: org === H2 ? "INR" : "AED", department: { _id: "d1", name: "Legal" } },
    createdBy: { _id: "u1", name: "Hana HR" }, createdAt: "2026-11-24T12:21:31.310Z", ...x,
  });
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const send = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const org = url.searchParams.get("organizationId") ?? "";
    const q = queue.get(org);
    if (req.method === "GET" && url.pathname === "/api/v1/integrations/one-time-payments/requests") {
      stand.reads++;
      if (stand.down) return send(500, { success: false, message: "HRMS is having a moment" });
      return send(200, { success: true, data: [...(q?.values() ?? [])] });
    }
    const m = url.pathname.match(/^\/api\/v1\/integrations\/one-time-payments\/requests\/([^/]+)\/(paid|reject)$/);
    if (req.method === "POST" && m) {
      const row = q?.get(m[1]!);
      if (!row) return send(404, { success: false, message: "One-time payment not found" });
      q!.delete(m[1]!);
      return send(200, { success: true, data: { ...row, financeStatus: m[2] === "paid" ? "paid" : "rejected", ...JSON.parse(raw || "{}") } });
    }
    send(404, { success: false, message: "Route not found" });
  });
});
await new Promise<void>((ok) => server.listen(PORT, "127.0.0.1", ok));

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();

const ORG = new Types.ObjectId().toString();
await PayrollOrgLink.collection.insertMany([
  { organizationId: new Types.ObjectId(ORG), hrmsOrgId: H, hrmsOrgName: "Delta HQ", isActive: true },
  { organizationId: new Types.ObjectId(ORG), hrmsOrgId: H2, hrmsOrgName: "Delta Bangalore", isActive: true },
  { organizationId: new Types.ObjectId(), hrmsOrgId: new Types.ObjectId().toString(), hrmsOrgName: "Elsewhere", isActive: true },
]);
const USER = new Types.ObjectId();
await User.collection.insertOne({ _id: USER, name: "Fina Finance", email: "fina@e2e.test", organizationId: new Types.ObjectId(ORG) });
const auth = { userId: String(USER), organizationId: ORG, role: "Admin", permissions: ["expense:approve"], isSuperAdmin: false };
const forget = () => { approvals.forgetOneTimePayments(H); approvals.forgetOneTimePayments(H2); };
const groupOf = async (a: unknown = auth) => (await approvals.approvalSummary(a as never)).groups.find((g) => g.type === "one_time_payment");
const list = (status: string, x: Record<string, unknown> = {}) =>
  approvals.approvalList(auth as never, { status, type: "one_time_payment", page: 1, pageSize: 20, ...x } as never);
const markPaid = (org: string, id: string) => svc.markPaid(ORG, String(USER), id, markOneTimePaidSchema.parse({
  hrmsOrgId: org, category: "payroll_benefits", subcategory: "bonuses", note: "", paidOn: "2026-11-24", paymentMethod: "bank_transfer", reference: `TRF-${id}`,
}));

/* ── 1 ── */
step("1. The summary — the sidebar's count");
payment(H, "loan", { label: "Loan Credit", employee: { _id: "e-s", name: "Suhail M", employeeCode: "E0203", currency: "AED", department: { _id: "d1", name: "Legal" } }, notes: "Safeer Sir told" });
payment(H, "bonus", { label: "Eid bonus", amount: 500, createdAt: "2026-11-20T08:00:00.000Z" });
payment(H2, "arrears", { label: "Arrears", amount: 12_000, employee: { _id: "e-b", name: "Bina B", employeeCode: "BLR-007", currency: "INR", department: null }, createdAt: "2026-11-22T08:00:00.000Z" });
forget();
const summary = await approvals.approvalSummary(auth as never);
const group = summary.groups.find((g) => g.type === "one_time_payment");
check("a One-time payments group, linking to its page", group?.label === "One-time payments" && group.href === "/one-time-payments", j(group));
check("…counting the three waiting in both linked HRMS organisations", group?.count === 3, j(group?.count));
check("…newest first: Loan Credit — Suhail M, AED 4,000, for 2026-11, Legal", group?.items[0]?.title === "Loan Credit — Suhail M" && group.items[0]?.amountMinor === 400_000 && group.items[0]?.currency === "AED" && /Legal · for 2026-11/.test(group.items[0]?.subtitle ?? ""), j(group?.items[0]));
check("…a rupee one in rupees, from the HRMS organisation when there is no department", group?.items.some((i) => i.title === "Arrears — Bina B" && i.currency === "INR" && i.amountMinor === 1_200_000 && /^Delta Bangalore · for 2026-11/.test(i.subtitle ?? "")) === true, j(group?.items));
check("…in the Approvals total (the sidebar's Approvals badge)", summary.total >= 3 && summary.total === summary.groups.reduce((n, g) => n + g.count, 0), j({ total: summary.total }));

/* ── 2 ── */
step("2. The Approvals list");
const pending = await list("pending");
const loan = pending.rows.find((r) => r.id === "loan");
check("waiting: the three, read live from HRMS", pending.rows.length === 3 && pending.meta.total === 3, j(pending.rows.map((r) => r.id)));
check("…pending, raised by HR's person, opening the One-time Payments page", loan?.status === "pending" && loan.raisedBy === "Hana HR" && loan.href === "/one-time-payments" && loan.type === "one_time_payment", j(loan));
const found = await list("pending", { q: "suhail" });
check("…the search finds it by the employee's name", found.rows.length === 1 && found.rows[0]!.id === "loan", j(found.rows.map((r) => r.id)));
const all = await approvals.approvalList(auth as never, { status: "pending", page: 1, pageSize: 50 } as never);
check("…and on the All kinds list", all.rows.some((r) => r.type === "one_time_payment" && r.id === "loan"), j(all.rows.map((r) => `${r.type}:${r.id}`)));

/* ── 3 ── */
step("3. Kept two minutes, asked again after a decision");
payment(H, "late1", { label: "Late one" });
payment(H, "late2", { label: "Late two" });
check("two more in HRMS: the count is kept (no call to HRMS per sidebar per minute)", (await groupOf())?.count === 3);
const readsBefore = stand.reads;
await markPaid(H, "loan");
const afterPaid = await groupOf();
check("Mark paid: HRMS is asked again — the paid one gone, the two new ones counted", afterPaid?.count === 4 && stand.reads > readsBefore, j({ count: afterPaid?.count, reads: stand.reads - readsBefore }));
await svc.reject(ORG, "late2", { hrmsOrgId: H, note: "Not this month" });
check("Reject: gone from the count straight away", (await groupOf())?.count === 3);
const approvedRows = await list("approved");
check("approved: the one paid, by its expense, and who paid", approvedRows.rows.length === 1 && approvedRows.rows[0]!.decidedBy === "Fina Finance" && /^\/expenses\//.test(approvedRows.rows[0]!.href ?? "") && approvedRows.rows[0]!.amountMinor === 400_000 && /^Loan Credit — Suhail M$/.test(approvedRows.rows[0]!.title), j(approvedRows.rows));
check("rejected: kept only in HRMS, so not listed", (await list("rejected")).rows.length === 0);

/* ── 4 ── */
step("4. Who sees it");
check("not counted for somebody without expense:approve", !(await groupOf({ ...auth, permissions: ["invoice:approve"] })));

/* ── 5 ── */
step("5. HRMS not answering");
stand.down = true;
forget();
const down = await groupOf();
check("the kind says it could not be read — not a confident 0", down?.count === 0 && !!down.unavailable, j(down));
const downList = await list("pending");
check("…the list says so too", downList.rows.length === 0 && (downList.meta.unavailable ?? []).some((u) => /One-time payments/i.test(u)), j(downList.meta));
stand.down = false;
forget();
check("back: counted again", (await groupOf())?.count === 3);

server.close();
await mongoose.disconnect();
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
