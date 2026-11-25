/**
 * The Revenue report with the other organization's money beside it (the user, 2026-11-25: "if Bangalore received the
 * amount, also show here and mention it's in Bangalore"): Delta HQ (AED) shows Delta Banglore's rupees per group —
 * the same person in both — and as its own total, never added to the dirhams; a person only in Bangalore gets their
 * own row; filters and search apply; only for someone in both organizations (or a super admin); an AED organization
 * beside isn't "other". Run through scripts/revenue-other-org-e2e.sh (throwaway mongod).
 */
import mongoose, { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) { console.error(`Refusing: ${uri}`); process.exit(1); }
const { getRevenueAnalysis } = await import("../modules/reports/analysis.service");
let failures = 0, checks = 0;
const check = (label: string, ok: boolean, detail = "") => { checks++; if (ok) console.log(`  ✓ ${label}`); else { failures++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); } };
const j = (v: unknown) => String(JSON.stringify(v)).slice(0, 600);

await mongoose.connect(uri);
await mongoose.connection.db!.dropDatabase();
const db = mongoose.connection.db!;
const HQ = new Types.ObjectId(), BLR = new Types.ObjectId(), ELSE = new Types.ObjectId();
await db.collection("organizations").insertMany([
  { _id: HQ, name: "Delta International Management", baseCurrency: "AED" },
  { _id: BLR, name: "Delta Banglore", baseCurrency: "INR" },
  { _id: ELSE, name: "Elsewhere", baseCurrency: "AED" },
]);
const SALES = new Types.ObjectId();
await db.collection("departments").insertOne({ _id: SALES, organizationId: HQ, name: "Sales" });
const yamini = new Types.ObjectId(), ria = new Types.ObjectId(), acc = new Types.ObjectId(), hqOnly = new Types.ObjectId();
await db.collection("users").insertMany([
  { _id: yamini, name: "Yamini", email: "y@e2e.local", memberships: [{ organizationId: HQ, departmentId: SALES }, { organizationId: BLR }] },
  { _id: ria, name: "Ria", email: "r@e2e.local", memberships: [{ organizationId: BLR }] },
  { _id: acc, name: "Accounts", email: "a@e2e.local", memberships: [{ organizationId: HQ }, { organizationId: BLR }] },
  { _id: hqOnly, name: "HQ only", email: "h@e2e.local", memberships: [{ organizationId: HQ }] },
]);
const at = (d: string) => new Date(`${d}T00:00:00.000Z`);
let n = 0;
const inv = (org: Types.ObjectId, sp: Types.ObjectId, name: string, pays: [string, number, string][], o: Record<string, unknown> = {}) => ({
  organizationId: org, invoiceNumber: `IN-${String(++n).padStart(5, "0")}`, customerName: `Client ${n}`, salespersonId: sp, salespersonName: name,
  issueDate: at(pays[0]![0]), status: "paid", currency: String(org) === String(BLR) ? "INR" : "AED", totalMinor: pays.reduce((s, p) => s + p[1], 0), balanceMinor: 0,
  enrolment: { course: "MBT", crm: "delta", academy: String(org) === String(BLR) ? "bangalore" : "dubai" },
  payments: pays.map(([d, a, m]) => ({ _id: new Types.ObjectId(), paidOn: at(d), amountMinor: a, method: m })), ...o,
});
await db.collection("invoices").insertMany([
  inv(HQ, yamini, "Yamini J", [["2026-11-02", 225_000, "tabby"]]),
  inv(HQ, yamini, "Yamini J", [["2026-11-03", 550_000, "tabby"]]),
  inv(BLR, yamini, "Yamini J", [["2026-11-10", 5_737_500, "inr_bank_account"]]),
  inv(BLR, ria, "Ria", [["2026-11-12", 4_800_000, "inr_bank_account"]]),
  inv(BLR, ria, "Ria", [["2026-10-12", 100_000, "inr_bank_account"]]),
  inv(BLR, ria, "Ria", [["2026-11-13", 900_000, "inr_bank_account"]], { status: "void" }),
  inv(ELSE, yamini, "Yamini J", [["2026-11-04", 999_900, "cash"]]),
]);
const NOV = { from: "2026-11-01", to: "2026-11-30", basis: "collected", groupBy: "salesperson", filters: {} as Record<string, string> };

const r = await getRevenueAnalysis(String(HQ), NOV, { userId: String(acc) });
const y = r.groups.find((g) => g.name === "Yamini J");
check("Delta HQ's own figures unchanged: AED 7,750, 2 payments", r.totals.amountMinor === 775_000 && r.totals.count === 2 && r.currency === "AED", j(r.totals));
check("Yamini: AED 7,750 here, and ₹57,375 (1 payment) in Bangalore beside it", y?.amountMinor === 775_000 && y?.other?.amountMinor === 5_737_500 && y?.other?.count === 1, j(y));
const riaRow = r.groups.find((g) => g.name === "Ria");
check("Ria (Bangalore only): her own row, 0 here, ₹48,000 there", riaRow?.amountMinor === 0 && riaRow?.count === 0 && riaRow?.other?.amountMinor === 4_800_000, j(riaRow));
check("Bangalore total ₹1,05,375 in 2 payments, named, in INR — October and void left out", r.other?.organizationName === "Delta Banglore" && r.other.currency === "INR" && r.other.amountMinor === 10_537_500 && r.other.count === 2, j(r.other));
check("its records carry INR and are listed for the export", r.other?.records.length === 2 && r.other.records.every((x) => x.currency === "INR" && x.dims.salesperson), j(r.other?.records));
check("an AED organization beside (Elsewhere) isn't counted anywhere", !JSON.stringify(r).includes("999900"));
check("Ria is offered in the salesperson filter", r.options.salesperson?.some((o) => o.name === "Ria") === true, j(r.options.salesperson));
const f = await getRevenueAnalysis(String(HQ), { ...NOV, filters: { salesperson: String(ria) } }, { userId: String(acc) });
check("a salesperson filter applies there too: Ria only", f.other?.amountMinor === 4_800_000 && f.groups.length === 1, j(f.groups));
const s = await getRevenueAnalysis(String(HQ), { ...NOV, search: "Client 3" }, { userId: String(acc) });
check("search applies there too", s.other?.count === 1 && s.other.amountMinor === 5_737_500, j(s.other));
const byMethod = await getRevenueAnalysis(String(HQ), { ...NOV, groupBy: "method" }, { userId: String(acc) });
check("grouped by method: INR Transfer only on the Bangalore side", byMethod.groups.some((g) => /INR/i.test(g.name) && g.amountMinor === 0 && g.other?.amountMinor === 10_537_500), j(byMethod.groups));
const notIn = await getRevenueAnalysis(String(HQ), NOV, { userId: String(hqOnly) });
check("someone not in Bangalore: nothing from it", !notIn.other && notIn.groups.every((g) => !g.other), j(notIn.other));
const sa = await getRevenueAnalysis(String(HQ), NOV, { userId: String(hqOnly), isSuperAdmin: true });
check("a super admin sees it", sa.other?.amountMinor === 10_537_500);
const fromBlr = await getRevenueAnalysis(String(BLR), NOV, { userId: String(acc) });
check("opened in Delta Banglore: the dirham organizations beside it (HQ) in AED", fromBlr.currency === "INR" && fromBlr.other?.currency === "AED", j(fromBlr.other && { ...fromBlr.other, records: undefined }));
const inv2 = await getRevenueAnalysis(String(HQ), { ...NOV, basis: "invoiced" }, { userId: String(acc) });
check("Invoiced: Bangalore's invoices beside too", inv2.groups.find((g) => g.name === "Yamini J")?.other?.amountMinor === 5_737_500, j(inv2.groups));
const plain = await getRevenueAnalysis(String(HQ), NOV);
check("without a viewer (old callers): as before", !plain.other);

console.log(`\n${checks - failures}/${checks} checks passed`);
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
