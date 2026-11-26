/**
 * The Revenue report's Collected with money paid in other currencies beside it (the user, 2026-11-26: "show INR
 * collected as separate instead of summing AED, same as the payment page"): a payment in rupees (or dollars) on an AED
 * invoice is out of Collected — its total, groups and records — and given as it was paid, a line per currency, with
 * what it was recorded as; one whose amount in that currency was never recorded stays in Collected and is counted on
 * its currency's line; filters, search and grouping apply; Invoiced, the other organization's column and an
 * organization that keeps its books in rupees are as they were. Run through scripts/revenue-other-currency-e2e.sh
 * (throwaway mongod).
 */
import mongoose, { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) { console.error(`Refusing: ${uri}`); process.exit(1); }
const { getRevenueAnalysis } = await import("../modules/reports/analysis.service");
let failures = 0, checks = 0;
const check = (label: string, ok: boolean, detail = "") => { checks++; if (ok) console.log(`  ✓ ${label}`); else { failures++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); } };
const j = (v: unknown) => String(JSON.stringify(v)).slice(0, 700);

await mongoose.connect(uri);
await mongoose.connection.db!.dropDatabase();
const db = mongoose.connection.db!;
const HQ = new Types.ObjectId(), BLR = new Types.ObjectId();
await db.collection("organizations").insertMany([
  { _id: HQ, name: "Delta International Management", baseCurrency: "AED" },
  { _id: BLR, name: "Delta Banglore", baseCurrency: "INR" },
]);
const one = new Types.ObjectId(), two = new Types.ObjectId(), three = new Types.ObjectId(), acc = new Types.ObjectId();
await db.collection("users").insertMany([
  { _id: one, name: "Person One", email: "one@e2e.local", memberships: [{ organizationId: HQ }, { organizationId: BLR }] },
  { _id: two, name: "Person Two", email: "two@e2e.local", memberships: [{ organizationId: HQ }] },
  { _id: three, name: "Person Three", email: "three@e2e.local", memberships: [{ organizationId: HQ }] },
  { _id: acc, name: "Accounts", email: "a@e2e.local", memberships: [{ organizationId: HQ }, { organizationId: BLR }] },
]);
const at = (d: string) => new Date(`${d}T00:00:00.000Z`);
let n = 0;
type Pay = { on: string; minor: number; method: string } & Record<string, unknown>;
const inv = (org: Types.ObjectId, sp: Types.ObjectId, name: string, pays: Pay[]) => ({
  organizationId: org, invoiceNumber: `IN-${String(++n).padStart(5, "0")}`, customerName: `Client ${n}`, salespersonId: sp, salespersonName: name,
  issueDate: at(pays[0]!.on), status: "paid", currency: String(org) === String(BLR) ? "INR" : "AED", totalMinor: pays.reduce((s, p) => s + p.minor, 0), balanceMinor: 0,
  enrolment: { course: "MBT", crm: "delta", academy: String(org) === String(BLR) ? "bangalore" : "dubai" },
  payments: pays.map(({ on, minor, ...rest }) => ({ _id: new Types.ObjectId(), paidOn: at(on), amountMinor: minor, ...rest })),
});
await db.collection("invoices").insertMany([
  // 1 — dirhams, as ever.
  inv(HQ, one, "Person One", [{ on: "2026-11-02", minor: 225_000, method: "tabby" }]),
  // 2 — rupees typed where it was taken: INR 50,000 recorded as AED 2,000.
  inv(HQ, one, "Person One", [{ on: "2026-11-03", minor: 200_000, method: "inr_bank_account", original: { currency: "INR", amountMinor: 5_000_000, rate: 0.04 } }]),
  // 3 — a rupee method with no rupee amount on record: stays in Collected, said so.
  inv(HQ, two, "Person Two", [{ on: "2026-11-05", minor: 100_000, method: "razorpay" }]),
  // 4 — dollars: USD 817 recorded as AED 3,000.
  inv(HQ, two, "Person Two", [{ on: "2026-11-06", minor: 300_000, method: "bank_transfer", original: { currency: "USD", amountMinor: 81_700, rate: 3.672 } }]),
  // 5 — rupees known from what landed in the rupee account; this person has nothing in dirhams.
  inv(HQ, three, "Person Three", [{ on: "2026-11-07", minor: 150_000, method: "inr_bank_account", bankCurrency: "INR", bankAmountMinor: 3_750_000 }]),
  // 6 — October: out of the period.
  inv(HQ, one, "Person One", [{ on: "2026-10-20", minor: 80_000, method: "inr_bank_account", original: { currency: "INR", amountMinor: 2_000_000, rate: 0.04 } }]),
  // 7 — the rupee organization's own money: rupees on a rupee invoice are nobody's "other currency".
  inv(BLR, one, "Person One", [{ on: "2026-11-10", minor: 5_737_500, method: "inr_bank_account" }]),
]);
const NOV = { from: "2026-11-01", to: "2026-11-30", basis: "collected", groupBy: "salesperson", filters: {} as Record<string, string> };
const viewer = { userId: String(acc) };

const r = await getRevenueAnalysis(String(HQ), NOV, viewer);
const line = (rep: typeof r, c: string) => rep.foreign?.lines.find((l) => l.currency === c);
check("Collected is dirhams only: AED 3,250 in 2 payments", r.totals.amountMinor === 325_000 && r.totals.count === 2 && r.totals.collectedMinor === 325_000 && r.currency === "AED", j(r.totals));
check("no currency switch: the report is one currency's", (r.currencies ?? []).join() === "AED" && r.byCurrency?.length === 1, j({ c: r.currencies, b: r.byCurrency }));
check("rupees apart: INR 87,500 in 2 payments, recorded as AED 3,500", line(r, "INR")?.amountMinor === 8_750_000 && line(r, "INR")?.count === 2 && line(r, "INR")?.recordedMinor === 350_000, j(r.foreign?.lines));
check("dollars apart: USD 817 in 1 payment, recorded as AED 3,000", line(r, "USD")?.amountMinor === 81_700 && line(r, "USD")?.count === 1 && line(r, "USD")?.recordedMinor === 300_000, j(r.foreign?.lines));
check("the rupee payment with no rupee amount stays in Collected, and is said: 1, AED 1,000", line(r, "INR")?.unknownCount === 1 && line(r, "INR")?.unknownMinor === 100_000 && line(r, "USD")?.unknownCount === 0, j(r.foreign?.lines));
check("the lines: what was recorded as most first — INR, then USD", r.foreign?.lines.map((l) => l.currency).join() === "INR,USD", j(r.foreign?.lines));
const recorded = (r.foreign?.lines ?? []).reduce((s, l) => s + l.recordedMinor, 0);
check("nothing lost: Collected + what the others were recorded as = every November payment (AED 9,750)", r.totals.amountMinor + recorded === 975_000, String(r.totals.amountMinor + recorded));
const g1 = r.groups.find((g) => g.name === "Person One"), g2 = r.groups.find((g) => g.name === "Person Two"), g3 = r.groups.find((g) => g.name === "Person Three");
check("Person One: AED 2,250 (1), INR 50,000 (1) beside, Bangalore's rupees still beside", g1?.amountMinor === 225_000 && g1?.count === 1 && j(g1?.foreign) === j([{ currency: "INR", amountMinor: 5_000_000, count: 1 }]) && g1?.other?.amountMinor === 5_737_500, j(g1));
check("Person Two: AED 1,000 (1), USD 817 (1) beside", g2?.amountMinor === 100_000 && g2?.count === 1 && j(g2?.foreign) === j([{ currency: "USD", amountMinor: 81_700, count: 1 }]), j(g2));
check("Person Three (rupees only): their own row, nothing in dirhams, INR 37,500", g3?.amountMinor === 0 && g3?.count === 0 && j(g3?.foreign) === j([{ currency: "INR", amountMinor: 3_750_000, count: 1 }]), j(g3));
check("rows with dirhams first, the rupees-only row after", r.groups.map((g) => g.name).join() === "Person One,Person Two,Person Three", r.groups.map((g) => g.name).join());
check("the dirham records: 2, none of them a rupee figure; the one paid by Razorpay says INR", r.records.length === 2 && r.records.every((x) => x.recordedMinor === undefined && !x.currency) && r.records.find((x) => x.paidIn)?.paidIn === "INR" && r.records.filter((x) => x.paidIn).length === 1, j(r.records.map((x) => [x.number, x.amountMinor, x.paidIn])));
check("the other-currency records: 3, each in its currency with what it was recorded as, newest first", r.foreign?.records.length === 3
  && r.foreign.records.map((x) => `${x.currency} ${x.amountMinor} ${x.recordedMinor}`).join("|") === "INR 3750000 150000|USD 81700 300000|INR 5000000 200000", j(r.foreign?.records.map((x) => [x.date, x.currency, x.amountMinor, x.recordedMinor])));
check("October's rupee payment is in neither", !JSON.stringify(r).includes("2000000") && !JSON.stringify(r).includes("80000,"), "");
check("Bangalore's own column is as it was: INR 57,375 in 1 payment", r.other?.currency === "INR" && r.other.amountMinor === 5_737_500 && r.other.count === 1, j(r.other && { ...r.other, records: undefined }));
const inr = r.options.method?.find((o) => o.key === "inr_bank_account");
check("INR Transfer is offered in the method filter (2), though nothing of it is in dirhams", inr?.count === 2, j(r.options.method));
check("the salesperson with rupees only is offered too", r.options.salesperson?.some((o) => o.name === "Person Three") === true, j(r.options.salesperson));

const f = await getRevenueAnalysis(String(HQ), { ...NOV, filters: { method: "inr_bank_account" } }, viewer);
check("filtered to INR Transfer: nothing in Collected, INR 87,500 beside, no dollars", f.totals.amountMinor === 0 && f.totals.count === 0 && f.foreign?.lines.length === 1 && line(f, "INR")?.amountMinor === 8_750_000 && line(f, "INR")?.unknownCount === 0, j(f.foreign?.lines));
check("…and its rows are the two people who took rupees", f.groups.map((g) => g.name).sort().join() === "Person One,Person Three" && f.groups.every((g) => g.amountMinor === 0 && g.foreign?.length === 1), j(f.groups));
const s = await getRevenueAnalysis(String(HQ), { ...NOV, search: "Client 2" }, viewer);
check("search applies: Client 2's payment only — INR 50,000", s.totals.count === 0 && s.foreign?.records.length === 1 && line(s, "INR")?.amountMinor === 5_000_000, j(s.foreign?.lines));
const m = await getRevenueAnalysis(String(HQ), { ...NOV, groupBy: "method" }, viewer);
const mInr = m.groups.find((g) => g.key === "inr_bank_account"), mRzp = m.groups.find((g) => g.key === "razorpay");
check("grouped by method: INR Transfer has rupees only; Razorpay (amount not recorded) is still dirhams", mInr?.amountMinor === 0 && mInr?.foreign?.[0]?.amountMinor === 8_750_000 && mRzp?.amountMinor === 100_000 && !mRzp?.foreign, j(m.groups));
const two_ = await getRevenueAnalysis(String(HQ), { ...NOV, filters: { salesperson: String(two) } }, viewer);
check("one person's view: their dirhams, their dollars, and their unrecorded rupee payment", two_.totals.amountMinor === 100_000 && two_.foreign?.lines.map((l) => `${l.currency}:${l.amountMinor}:${l.count}:${l.unknownCount}`).join() === "USD:81700:1:0,INR:0:0:1", j(two_.foreign?.lines));

const i = await getRevenueAnalysis(String(HQ), { ...NOV, basis: "invoiced" }, viewer);
check("Invoiced is as it was: every invoice in dirhams, nothing set apart", !i.foreign && i.groups.every((g) => !g.foreign) && i.totals.amountMinor === 975_000 && i.totals.collectedMinor === 975_000, j(i.totals));
const b = await getRevenueAnalysis(String(BLR), NOV, viewer);
check("opened in Delta Banglore: rupees on rupee invoices are its Collected, nothing set apart", b.currency === "INR" && b.totals.amountMinor === 5_737_500 && !b.foreign, j({ t: b.totals, f: b.foreign?.lines }));
const none = await getRevenueAnalysis(String(HQ), { ...NOV, from: "2026-11-01", to: "2026-11-02" }, viewer);
check("a period with dirhams only: no other-currency part at all", !none.foreign && none.totals.amountMinor === 225_000 && none.groups.every((g) => !g.foreign), j(none.totals));

console.log(`\n${checks - failures}/${checks} checks passed`);
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
