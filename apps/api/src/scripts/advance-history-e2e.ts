/**
 * Salary advances — finance's full record (the user, 2026-10-20): GET /advances/history's service, against a
 * stand-in HRMS that checks finance's signature and answers like the real one (hrms-backend's
 * src/scripts/advanceHistoryCheck.ts checks the real one's side).
 *
 * What it proves:
 *   - each status is asked of every linked HRMS organisation, signed, and the rows come back newest first, each
 *     with the HRMS organisation it is from;
 *   - a paid one carries the expense finance recorded for it; one with none carries none;
 *   - an HRMS from before the full record — it ignores ?status= and sends its queue — is said so (503), never shown
 *     as paid or refused;
 *   - an organisation with no link reads nothing; the queue (listWaiting) is unchanged.
 *
 * Run through scripts/advance-history-e2e.sh (throwaway mongod, no .env anywhere).
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

/* ── A stand-in HRMS: two organisations' advances; `old` answers like an HRMS from before ?status= ── */
const H1 = new Types.ObjectId().toString(), H2 = new Types.ObjectId().toString();
const emp = (name: string) => ({ _id: name, name, employeeCode: `E-${name}`, designation: "Sales", department: { _id: "d1", name: "Sales" } });
const base = { currency: "AED", reason: "Rent", monthlySalary: 4000, neededBy: null, hrNote: "", months: null, startMonth: null };
const ADV: Record<string, any[]> = {
  [H1]: [
    { ...base, _id: "a-wael", status: "hr_approved", amount: 700, months: 2, startMonth: "2026-11", employee: emp("Wael"), createdAt: "2026-10-14T08:00:00.000Z" },
    { ...base, _id: "a-omar", status: "pending", amount: 400, employee: emp("Omar"), createdAt: "2026-10-18T08:00:00.000Z" },
    { ...base, _id: "a-anfas", status: "approved", amount: 1500, months: 3, startMonth: "2026-11", employee: emp("Anfas"), createdAt: "2026-10-09T08:00:00.000Z",
      financeRef: "EXP-00018", paidOn: "2026-10-12T00:00:00.000Z", paymentMethod: "bank_transfer" },
    { ...base, _id: "a-riswana", status: "rejected", amount: 100, rejectedBy: "hr", hrNote: "Already has a loan", employee: emp("Riswana"), createdAt: "2026-10-16T08:00:00.000Z" },
  ],
  [H2]: [
    { ...base, _id: "b-gopika", status: "approved", amount: 300, months: 1, startMonth: "2026-11", employee: emp("Gopika"), createdAt: "2026-10-11T08:00:00.000Z", financeRef: "EXP-00019" },
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
  if (url.pathname !== "/api/v1/integrations/advances/requests") return send(404, { success: false, message: "Route not found" });
  const all = ADV[org] ?? [];
  const want = stand.old || !status ? "hr_approved" : status;
  const rows = (want === "all" ? all : all.filter((r) => r.status === want)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
  organizationId: new Types.ObjectId(ORG), expenseNumber: "EXP-00018", status: "paid",
  source: { kind: "hrms_advance", key: `hrms-advance:${H1}:a-anfas`, hrmsOrgId: H1, requestId: "a-anfas", round: 0 },
});

/* ── 1 ── */
step("1. Each tab");
let rows = await adv.listHistory(ORG, "approved");
check("Approved: paid ones from both HRMS organisations, newest first", j(rows.map((r) => r._id)) === j(["b-gopika", "a-anfas"]), j(rows.map((r) => r._id)));
const anfas = rows.find((r) => r._id === "a-anfas");
check("…Anfas: the expense finance recorded, paid on, method, recovery", anfas?.expense?.expenseNumber === "EXP-00018" && anfas.expense.id === String(exp.insertedId)
  && !!anfas.paidOn?.startsWith("2026-10-12") && anfas.paymentMethod === "bank_transfer" && anfas.months === 3 && anfas.hrmsOrgId === H1, j(anfas));
check("…Gopika: no expense here, HRMS's reference kept", rows.find((r) => r._id === "b-gopika")?.expense === null && rows.find((r) => r._id === "b-gopika")?.financeRef === "EXP-00019");
rows = await adv.listHistory(ORG, "rejected");
check("Rejected: Riswana, refused by HR, with the note", rows.length === 1 && rows[0]?.rejectedBy === "hr" && rows[0]?.hrNote === "Already has a loan", j(rows));
rows = await adv.listHistory(ORG, "pending");
check("Pending (still with HR): Omar", j(rows.map((r) => r._id)) === j(["a-omar"]), j(rows));
rows = await adv.listHistory(ORG, "all");
check("All: every one, newest first, across both", j(rows.map((r) => r._id)) === j(["a-omar", "a-riswana", "a-wael", "b-gopika", "a-anfas"]), j(rows.map((r) => r._id)));
const asked = stand.hits.filter((h) => h.status === "all");
check("each HRMS organisation asked, signed, with the status", asked.length === 2 && asked.every((h) => h.signed) && new Set(asked.map((h) => h.org)).size === 2, j(asked));

/* ── 2 ── */
step("2. The queue, unchanged");
const waiting = await adv.listWaiting(ORG);
check("listWaiting: only Wael, asked with no status", j(waiting.map((r) => r._id)) === j(["a-wael"]) && stand.hits.some((h) => h.status === null), j(waiting.map((r) => r._id)));

/* ── 3 ── */
step("3. An HRMS from before the full record");
stand.old = true;
check("Approved: refused, saying HRMS needs updating — never its queue shown as paid", /UNAVAILABLE HRMS needs updating/.test(await refusal(adv.listHistory(ORG, "approved"))));
check("Rejected: the same", /HRMS needs updating/.test(await refusal(adv.listHistory(ORG, "rejected"))));
stand.old = false;

/* ── 4 ── */
step("4. An organisation with no link");
check("reads nothing", (await adv.listHistory(LONER, "all")).length === 0);

server.close();
console.log(`\n${checks - failures}/${checks} passed`);
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
