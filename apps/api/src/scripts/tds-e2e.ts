/**
 * TDS on vendor bills, Bangalore only (the user, 2026-11-11: "TDS section required", "is only for the bangalore only")
 * — finance's services in this process, on a scratch database:
 *
 *   1. An organization keeping AED books: no TDS — not offered, settings refused, a section named on a bill refused,
 *      a vendor's own section quietly left off.
 *   2. The INR (Bangalore) organization: the usual sections to start with; a bill under the vendor's section has TDS
 *      worked out before GST, rounded to the rupee; the vendor is owed the total less it; paid in full, it's paid; no
 *      more than that can be paid. Lines changed — worked out again; the section taken off — owed in full again;
 *      TDS added after more than the rest was paid — refused. A rate changed later leaves old bills as they were.
 *   3. The TDS report by month and section, the bills behind it with the vendor's PAN; a TDS payment from an INR
 *      account puts a line in Banking and counts as paid; taken back, its line goes.
 *
 * Run through scripts/tds-e2e.sh. Scratch databases only.
 */
import mongoose, { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}

const { Organization } = await import("../modules/organization/organization.model");
const { Vendor } = await import("../modules/vendor/vendor.model");
const { Expense } = await import("../modules/expense/expense.model");
const { BankTransaction } = await import("../modules/banking/bank-transaction.model");
const banking = await import("../modules/banking/banking.service");
const bills = await import("../modules/bill/bill.service");
const tds = await import("../modules/tds/tds.service");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const j = (v: unknown) => JSON.stringify(v).slice(0, 500);
const refusal = async (p: Promise<unknown>) => p.then(() => "", (e: Error) => e.message);

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();

const hq = await Organization.create({ name: "Delta HQ E2E", baseCurrency: "AED", lateEntryDays: 0 });
const blr = await Organization.create({ name: "Delta Bangalore E2E", baseCurrency: "INR", lateEntryDays: 0, taxSystem: "gst", taxLabel: "GST" });
const HQ = String(hq._id), BLR = String(blr._id);
const vendorIn = (orgId: string, name: string, over: Record<string, unknown> = {}) => Vendor.create({ organizationId: new Types.ObjectId(orgId), vendorCode: `VEN-${Math.random().toString().slice(2, 7)}`, name,
  email: `${name.toLowerCase().replace(/\W/g, "")}@e2e-tds.test`, phone: "+910000000000", currency: orgId === BLR ? "INR" : "AED", status: "active", ...over });
const bill = (orgId: string, vendorId: unknown, over: Record<string, unknown> = {}) => bills.createBill(orgId, {
  vendorId: String(vendorId), billDate: "2026-10-15", dueDate: "2026-10-30", category: "office_supplies", subcategory: "stationery",
  lineItems: [{ description: "Housekeeping, October", quantity: 1, unitPriceMinor: 1_234_567, discountPct: 0, taxPct: 18 }],
  notes: "", paymentTerms: "", requiresApproval: false, ...over,
} as never);
const pay = (orgId: string, id: string, amountMinor: number) => bills.recordBillPayment(orgId, id, { method: "bank_transfer", amountMinor, paidOn: "2026-10-31", reference: "", accountName: "", notes: "", chargesMinor: 0 } as never);

/* ── 1 ── */
step("1. AED books: no TDS");
const hqCfg = await tds.tdsConfig(HQ);
check("not offered", hqCfg.available === false && hqCfg.enabled === false);
check("settings refused", /INR \(Bangalore\)/.test(await refusal(tds.updateTdsConfig(HQ, { enabled: true }))));
const hqVendor = await vendorIn(HQ, "Gulf Cleaning", { tdsSection: "194C-O" });
check("a section named on a bill: refused", /Bangalore/.test(await refusal(bill(HQ, hqVendor._id, { tdsSection: "194C-O" }))));
const hqBill = await bill(HQ, hqVendor._id);
check("the vendor's own section: left off, owed in full", !hqBill.tds && hqBill.balanceMinor === hqBill.totalMinor, j(hqBill));
check("…the report refused", /Bangalore/.test(await refusal(tds.tdsReport(HQ, {}))));

/* ── 2 ── */
step("2. Bangalore: TDS on the bill");
const cfg = await tds.tdsConfig(BLR);
check("offered, on, the usual sections", cfg.available && cfg.enabled && cfg.sections.some((s) => s.code === "194C-O" && s.ratePct === 2) && cfg.sections.some((s) => s.code === "194J-P" && s.ratePct === 10), j(cfg));
const v = await vendorIn(BLR, "Cleaning Services", { tdsSection: "194C-O", pan: "ABCDE1234F" });
let b = await bill(BLR, v._id);
// Before GST: 12,345.67 × 2% = 246.91 → ₹247.00; the bill 12,345.67 + 18% GST 2,222.22 = 14,567.89.
check("the vendor's section: TDS before GST, to the rupee", b.tds?.section === "194C-O" && b.tds.baseMinor === 1_234_567 && b.tds.amountMinor === 24_700, j(b.tds));
check("…the vendor is owed the total less it", b.totalMinor === 1_456_789 && b.balanceMinor === 1_456_789 - 24_700, j({ t: b.totalMinor, bal: b.balanceMinor }));
const mirror = await Expense.findOne({ "source.key": `bill:${b.id}` }).lean<any>();
check("…its expense is the whole bill (the TDS is part of the cost)", mirror?.totalMinor === 1_456_789, j(mirror?.totalMinor));
check("paying more than that: refused", /exceeds|exceed/i.test(await refusal(pay(BLR, b.id, 1_456_789))));
b = await pay(BLR, b.id, 1_456_789 - 24_700);
check("paid what's owed: paid", b.status === "paid" && b.balanceMinor === 0, j({ s: b.status, bal: b.balanceMinor }));
let b2 = await bill(BLR, v._id, { tdsSection: "194J-P" });
check("a section named: that one (10%)", b2.tds?.section === "194J-P" && b2.tds.amountMinor === 123_500, j(b2.tds));
b2 = await bills.updateBill(BLR, b2.id, { lineItems: [{ description: "Audit", quantity: 2, unitPriceMinor: 500_000, discountPct: 0, taxPct: 18 }] } as never);
check("lines changed: worked out again", b2.tds?.amountMinor === 100_000 && b2.balanceMinor === 1_180_000 - 100_000, j({ tds: b2.tds, bal: b2.balanceMinor }));
b2 = await bills.updateBill(BLR, b2.id, { tdsSection: "" } as never);
check("section taken off: owed in full", !b2.tds && b2.balanceMinor === 1_180_000, j(b2));
b2 = await pay(BLR, b2.id, 1_150_000);
check("TDS put back after more than the rest was paid: refused", /paid already/.test(await refusal(bills.updateBill(BLR, b2.id, { tdsSection: "194J-P" } as never))));
check("an unknown section: refused", /No TDS section/.test(await refusal(bill(BLR, v._id, { tdsSection: "999X" }))));
await tds.updateTdsConfig(BLR, { sections: cfg.sections.map((s) => (s.code === "194C-O" ? { ...s, ratePct: 5 } : s)) });
const b3 = await bill(BLR, v._id);
check("a rate changed: new bills at it, old ones as they were", b3.tds?.ratePct === 5 && (await bills.getBill(BLR, b.id)).tds?.ratePct === 2, j({ n: b3.tds, o: (await bills.getBill(BLR, b.id)).tds }));
await tds.updateTdsConfig(BLR, { enabled: false });
const b4 = await bill(BLR, v._id);
check("TDS turned off: the vendor's section left off", !b4.tds && (await refusal(bill(BLR, v._id, { tdsSection: "194C-O" }))).includes("turned off"));
await tds.updateTdsConfig(BLR, { enabled: true });

/* ── 3 ── */
step("3. The report, and TDS paid");
const inr = await banking.createBankAccount(BLR, { accountName: "Federal Bank", currency: "INR", accountType: "current", openingBalanceMinor: 10_000_000, openingDate: "2026-01-01" } as never);
const usd = await banking.createBankAccount(BLR, { accountName: "USD Account", currency: "USD", accountType: "current", openingBalanceMinor: 0, openingDate: "2026-01-01" } as never);
let rep = await tds.tdsReport(BLR, { from: "2026-10-01", to: "2026-10-31" });
const row = (s: string) => rep.rows.find((r) => r.period === "2026-10" && r.section === s);
check("by month and section: the two 194C bills (2% and 5%), none left under 194J", row("194C-O")?.bills === 2 && row("194C-O")?.tdsMinor === 24_700 + 61_700 && !row("194J-P"), j(rep.rows));
check("…the bills behind it, with the vendor's PAN", rep.bills.some((x) => x.billNumber === b.billNumber && x.pan === "ABCDE1234F" && x.tdsMinor === 24_700), j(rep.bills));
check("a TDS payment from a USD account: refused", /TDS is paid in INR/.test(await refusal(tds.recordTdsPayment(BLR, { period: "2026-10", section: "194C-O", amountMinor: 24_700, paidOn: "2026-11-07", bankAccountId: usd.id, challanNo: "", notes: "" }))));
const paid = await tds.recordTdsPayment(BLR, { period: "2026-10", section: "194C-O", amountMinor: 24_700, paidOn: "2026-11-07", bankAccountId: inr.id, challanNo: "CHL-001", notes: "" });
const line = await BankTransaction.findOne({ accountId: new Types.ObjectId(inr.id), reference: "CHL-001" }).lean<any>();
check("paid: a money-out line in Federal Bank", line?.amountMinor === -24_700 && /TDS paid · 194C-O · 2026-10/.test(line.description), j(line));
rep = await tds.tdsReport(BLR, { from: "2026-10-01", to: "2026-10-31" });
check("…counted as paid, the rest still owed", row("194C-O")?.paidMinor === 24_700 && row("194C-O")?.owedMinor === (row("194C-O")?.tdsMinor ?? 0) - 24_700 && rep.payments[0]?.inBank === true, j(rep.rows));
await tds.deleteTdsPayment(BLR, paid.id);
check("taken back: its line gone", !(await BankTransaction.exists({ _id: line._id })) && (await tds.tdsReport(BLR, {})).payments.length === 0);

console.log(`\n${checks - failures}/${checks} passed`);
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
