/**
 * One-time payments — finance's full record (the user, 2026-10-21): GET /one-time-payments/history's service,
 * against a stand-in HRMS that checks finance's signature and answers like the real one (hrms-backend's
 * src/scripts/oneTimeHistoryCheck.ts checks the real one's side).
 *
 * What it proves:
 *   - each status is asked of every linked HRMS organisation, signed, and the rows come back newest first, each
 *     with the HRMS organisation it is from;
 *   - a paid one carries the expense finance recorded for it; one with none carries none;
 *   - an HRMS from before the full record — it ignores ?status= and sends its queue — is said so (503), never shown
 *     as paid or refused;
 *   - an organisation with no link reads nothing; the queue (listWaiting) is unchanged.
 *
 * Run through scripts/one-time-history-e2e.sh (throwaway mongod, no .env anywhere).
 */
import crypto from "node:crypto";
import http from "node:http";
import mongoose, { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}
const SECRET = process.env.HRMS_INTEGRATION_SECRET ?? "";
const PORT = Number(new URL(process.env.HRMS_API_URL ?? "http://127.0.0.1:0").port);

const { PayrollOrgLink } = await import("../modules/payroll-mapping/org-link.model");
const { Expense } = await import("../modules/expense/expense.model");
const otp = await import("../modules/one-time-payments/one-time-payments.service");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const j = (v: unknown) => JSON.stringify(v).slice(0, 400);
const refusal = async (p: Promise<unknown>) => p.then(() => "", (e: Error & { code?: string }) => `${e.code ?? ""} ${e.message}`);

/* ── A stand-in HRMS: two organisations' payments; `old` answers like an HRMS from before ?status= ── */
const H1 = new Types.ObjectId().toString(), H2 = new Types.ObjectId().toString();
const emp = (name: string) => ({ _id: name, name, employeeCode: `E-${name}`, designation: "Sales", currency: "AED", department: { _id: "d1", name: "Sales" } });
const base = { month: "2026-10", notes: "", createdBy: { _id: "hr", name: "Super Admin" }, paidOn: null, paymentMethod: "", paymentRef: "", financeNote: "" };
const PAY: Record<string, any[]> = {
  [H1]: [
    { ...base, _id: "p-ashik", financeStatus: "with_finance", label: "Annual leave settlement", amount: 5133.3, employee: emp("Ashik"), createdAt: "2026-10-20T08:00:00.000Z" },
    { ...base, _id: "p-sana", financeStatus: "paid", label: "Bonus", amount: 2000, employee: emp("Sana"), createdAt: "2026-10-09T08:00:00.000Z",
      paidOn: "2026-10-12T00:00:00.000Z", paymentMethod: "bank_transfer", paymentRef: "TRX-77" },
    { ...base, _id: "p-omar", financeStatus: "rejected", label: "Bonus", amount: 700, financeNote: "Not agreed", employee: emp("Omar"), createdAt: "2026-10-15T08:00:00.000Z" },
  ],
  [H2]: [
    { ...base, _id: "q-libin", financeStatus: "paid", label: "Travel allowance", amount: 1300, employee: emp("Libin"), createdAt: "2026-10-11T08:00:00.000Z", paymentMethod: "cash" },
  ],
};
const stand = { old: false, hits: [] as Array<{ org: string; status: string | null; signed: boolean }> };
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const ts = String(req.headers["x-delta-timestamp"] ?? ""), nonce = String(req.headers["x-delta-nonce"] ?? "");
  const canonical = [req.method, req.url, ts, nonce, crypto.createHash("sha256").update("").digest("hex")].join("\n");
  const signed = req.headers["x-delta-signature"] === crypto.createHmac("sha256", SECRET).update(canonical).digest("hex");
  const org = url.searchParams.get("organizationId") ?? "", status = url.searchParams.get("status");
  stand.hits.push({ org, status, signed });
  const send = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (url.pathname !== "/api/v1/integrations/one-time-payments/requests") return send(404, { success: false, message: "Route not found" });
  const all = PAY[org] ?? [];
  const want = stand.old || !status ? "with_finance" : status;
  const rows = (want === "all" ? all : all.filter((r) => r.financeStatus === want)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  send(200, { success: true, message: "ok", data: rows });
});
await new Promise<void>((ok) => server.listen(PORT, "127.0.0.1", ok));

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();

const ORG = new Types.ObjectId().toString(), LONER = new Types.ObjectId().toString();
await PayrollOrgLink.collection.insertMany([
  { organizationId: new Types.ObjectId(ORG), hrmsOrgId: H1, isActive: true },
  { organizationId: new Types.ObjectId(ORG), hrmsOrgId: H2, isActive: true },
]);
const exp = await Expense.collection.insertOne({
  organizationId: new Types.ObjectId(ORG), expenseNumber: "EXP-00040", status: "approved",
  source: { kind: "hrms_one_time", key: `hrms-one-time:${H1}:p-sana`, hrmsOrgId: H1, requestId: "p-sana", round: 0 },
});

/* ── 1 ── */
step("1. Each tab");
let rows = await otp.listHistory(ORG, "paid");
check("Approved (paid): from both HRMS organisations, newest first", j(rows.map((r) => r._id)) === j(["q-libin", "p-sana"]), j(rows.map((r) => r._id)));
const sana = rows.find((r) => r._id === "p-sana");
check("…Sana: the expense finance recorded, paid on, method, reference", sana?.expense?.expenseNumber === "EXP-00040" && sana.expense.id === String(exp.insertedId)
  && !!sana.paidOn?.startsWith("2026-10-12") && sana.paymentMethod === "bank_transfer" && sana.paymentRef === "TRX-77" && sana.hrmsOrgId === H1, j(sana));
check("…Libin: no expense here", rows.find((r) => r._id === "q-libin")?.expense === null);
rows = await otp.listHistory(ORG, "rejected");
check("Rejected: Omar, with finance's note", rows.length === 1 && rows[0]?._id === "p-omar" && rows[0]?.financeNote === "Not agreed", j(rows));
rows = await otp.listHistory(ORG, "all");
check("All: every one, newest first, across both", j(rows.map((r) => r._id)) === j(["p-ashik", "p-omar", "q-libin", "p-sana"]), j(rows.map((r) => r._id)));
const asked = stand.hits.filter((h) => h.status === "all");
check("each HRMS organisation asked, signed, with the status", asked.length === 2 && asked.every((h) => h.signed) && new Set(asked.map((h) => h.org)).size === 2, j(asked));

/* ── 2 ── */
step("2. The queue, unchanged");
const waiting = await otp.listWaiting(ORG);
check("listWaiting: only Ashik, asked with no status", j(waiting.map((r) => r._id)) === j(["p-ashik"]) && stand.hits.some((h) => h.status === null), j(waiting.map((r) => r._id)));

/* ── 3 ── */
step("3. An HRMS from before the full record");
stand.old = true;
check("Paid: refused, saying HRMS needs updating — never its queue shown as paid", /UNAVAILABLE HRMS needs updating/.test(await refusal(otp.listHistory(ORG, "paid"))));
check("Rejected: the same", /HRMS needs updating/.test(await refusal(otp.listHistory(ORG, "rejected"))));
stand.old = false;

/* ── 4 ── */
step("4. An organisation with no link");
check("reads nothing", (await otp.listHistory(LONER, "all")).length === 0);

server.close();
console.log(`\n${checks - failures}/${checks} passed`);
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
