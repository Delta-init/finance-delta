/**
 * The Payments list's cards (the user, 2026-11-20: "add stats cards in the payments page also") — paymentSummary
 * against a scratch database, beside the list it sits above.
 *
 * What it proves:
 *   - the count is every payment the filters match — the same number the table lists, with no filter and with each
 *     (method, paid dates, search, one invoice) and all of them at once;
 *   - Received is per invoice currency, never added across, and adds up to the table's own amounts — less the
 *     payments made in another currency whose amount there was recorded;
 *   - those are in Paid in other currencies, in the currency they were paid, never converted, with what they were
 *     recorded as; one whose amount there was never recorded stays in Received, and is counted as such;
 *   - By method adds up to Received per currency, and the other currency's methods to its own amount;
 *   - another organization's payments never show; an organization with none gets zeros, not an error;
 *   - "/summary" is routed before "/:id", so it is never read as a payment's id.
 *
 * Run through scripts/payments-summary-e2e.sh (throwaway mongod, no .env anywhere).
 */
import mongoose, { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}

const { listPayments, paymentSummary } = await import("../modules/invoice/payment.service");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const j = (v: unknown) => String(JSON.stringify(v)).slice(0, 700);

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();
const invoices = mongoose.connection.db!.collection("invoices");

const ORG = new Types.ObjectId(), OTHER = new Types.ObjectId(), EMPTY = new Types.ObjectId();
const day = (d: string) => new Date(`${d}T00:00:00.000Z`);
let n = 0;
type Pay = { method: string; amountMinor: number; paidOn: string; original?: { currency: string; amountMinor?: number }; bankCurrency?: string; bankAmountMinor?: number };
async function invoice(org: Types.ObjectId, customerName: string, currency: string | null, pays: Pay[]) {
  const _id = new Types.ObjectId();
  const total = pays.reduce((s, p) => s + p.amountMinor, 0) || 10_000;
  await invoices.insertOne({
    _id, organizationId: org, invoiceNumber: `IN-${String(++n).padStart(5, "0")}`, customerId: new Types.ObjectId(), customerName,
    ...(currency ? { currency } : {}), status: "paid", totalMinor: total, amountPaidMinor: total, balanceMinor: 0,
    payments: pays.map((p, i) => ({
      _id: new Types.ObjectId(), method: p.method, amountMinor: p.amountMinor, paidOn: day(p.paidOn), createdAt: new Date(Date.now() + n * 1000 + i),
      reference: `REF-${n}-${i}`, ...(p.original ? { original: p.original } : {}),
      ...(p.bankCurrency ? { bankCurrency: p.bankCurrency, bankAmountMinor: p.bankAmountMinor } : {}),
    })),
    createdAt: new Date(),
  });
  return _id;
}

const alpha = await invoice(ORG, "Alpha Trading", "AED", [
  { method: "cash", amountMinor: 100_000, paidOn: "2026-11-01" },
  { method: "card", amountMinor: 50_000, paidOn: "2026-11-10" },
]);
await invoice(ORG, "Beta Holdings", "AED", [
  { method: "bank_transfer", amountMinor: 200_000, paidOn: "2026-11-15" },
  { method: "cash", amountMinor: 25_000, paidOn: "2026-10-20" },
]);
await invoice(ORG, "Gamma LLC", "USD", [{ method: "card", amountMinor: 30_000, paidOn: "2026-11-12" }]);
// Rupees on an AED invoice, the amount in rupees recorded: INR 22,750 recorded as AED 1,000.
await invoice(ORG, "Delta Rupee", "AED", [
  { method: "inr_bank_account", amountMinor: 100_000, paidOn: "2026-11-16", original: { currency: "INR", amountMinor: 2_275_000 } },
]);
// Rupees by a rupee method, the rupee amount never recorded: stays in Received at AED 400.
await invoice(ORG, "Echo Rupee", "AED", [{ method: "razorpay", amountMinor: 40_000, paidOn: "2026-11-17" }]);
// An invoice with no currency set reads as AED.
await invoice(ORG, "Foxtrot Old", null, [{ method: "cheque", amountMinor: 10_000, paidOn: "2026-09-30" }]);
// No payments: not in the list, not in the cards.
await invoice(ORG, "Golf Unpaid", "AED", []);
// Another organization's money.
await invoice(OTHER, "Alpha Elsewhere", "AED", [{ method: "cash", amountMinor: 9_999_900, paidOn: "2026-11-01" }]);

/** Every row the list gives for these filters, every page. */
async function allRows(org: Types.ObjectId, f: Record<string, string | undefined>) {
  const rows: Array<{ amountMinor: number; currency?: string; method: string }> = [];
  for (let page = 1; ; page++) {
    const r = await listPayments(String(org), { ...f, page, limit: 100 });
    rows.push(...r.data);
    if (page >= r.meta.totalPages || !r.data.length) return { rows, total: r.meta.total };
  }
}
const cur = (c?: string | null) => (c || "AED").toUpperCase();

/** The cards against the table, for one set of filters. */
async function agrees(label: string, f: Record<string, string | undefined>) {
  const s = await paymentSummary(String(ORG), f);
  const { rows, total } = await allRows(ORG, f);
  check(`${label}: count is the table's (${total})`, s.count === total, `cards ${s.count}`);
  const byCur = new Map<string, number>();
  for (const r of rows) byCur.set(cur(r.currency), (byCur.get(cur(r.currency)) ?? 0) + r.amountMinor);
  for (const g of s.byCurrency) {
    const recorded = (g.foreign ?? []).reduce((x, fl) => x + fl.recordedMinor, 0);
    check(`${label}: ${g.currency} Received + recorded elsewhere = the table's ${g.currency} amounts`,
      g.amountMinor + recorded === (byCur.get(g.currency) ?? 0), `${g.amountMinor} + ${recorded} vs ${byCur.get(g.currency)}`);
    check(`${label}: ${g.currency} by method adds up to Received`,
      g.byMethod.reduce((x, m) => x + m.amountMinor, 0) === g.amountMinor, j(g.byMethod));
    for (const fl of g.foreign ?? []) {
      check(`${label}: ${fl.currency} on ${g.currency} invoices by method adds up to its amount`,
        fl.byMethod.reduce((x, m) => x + m.amountMinor, 0) === fl.amountMinor, j(fl));
    }
  }
  check(`${label}: no currency missing from the cards`, [...byCur.keys()].every((c) => s.byCurrency.some((g) => g.currency === c)), j([...byCur.keys()]));
  return s;
}

step("No filter");
{
  const s = await agrees("all", {});
  check("8 payments (the other organization's and the unpaid invoice not among them)", s.count === 8, String(s.count));
  const aed = s.byCurrency.find((g) => g.currency === "AED");
  const usd = s.byCurrency.find((g) => g.currency === "USD");
  // AED: 1,000 + 500 + 2,000 + 250 + 400 (rupees, amount unknown) + 100 (no currency) = 4,250; the INR 22,750 apart.
  check("AED Received 4,250.00 — the rupees with their amount recorded left out", aed?.amountMinor === 425_000, j(aed));
  check("AED: 7 payments on AED invoices", aed?.count === 7, j(aed?.count));
  check("USD Received 300.00 on its own line, never added to AED", usd?.amountMinor === 30_000 && usd.count === 1, j(usd));
  const inr = aed?.foreign?.find((f) => f.currency === "INR");
  check("Paid in other currencies: INR 22,750.00, 1 payment, recorded as AED 1,000.00",
    inr?.amountMinor === 2_275_000 && inr.count === 1 && inr.recordedMinor === 100_000, j(inr));
  check("…and 1 INR payment without its amount, still in Received at AED 400.00",
    inr?.unknownCount === 1 && inr.unknownMinor === 40_000, j(inr));
  check("INR by method: the rupee bank account, in rupees", j(inr?.byMethod) === j([{ method: "inr_bank_account", count: 1, amountMinor: 2_275_000 }]), j(inr?.byMethod));
  const methods = Object.fromEntries((aed?.byMethod ?? []).map((m) => [m.method, [m.count, m.amountMinor]]));
  check("AED by method: bank 2,000 · cash 1,250 (2) · card 500 · razorpay 400 · cheque 100",
    j(methods) === j({ bank_transfer: [1, 200_000], cash: [2, 125_000], card: [1, 50_000], razorpay: [1, 40_000], cheque: [1, 10_000] }), j(methods));
  check("Methods largest first", (aed?.byMethod ?? []).every((m, i, a) => i === 0 || a[i - 1]!.amountMinor >= m.amountMinor), j(aed?.byMethod));
  check("USD has no other-currency line", !usd?.foreign, j(usd));
}

step("Each filter, as the table");
{
  const s = await agrees("method cash", { method: "cash" });
  check("cash: 2 payments, AED 1,250.00", s.count === 2 && s.byCurrency.length === 1 && s.byCurrency[0]!.amountMinor === 125_000, j(s));
}
{
  const s = await agrees("method inr_bank_account", { method: "inr_bank_account" });
  check("rupee bank account only: Received AED 0, INR 22,750 apart", s.count === 1 && s.byCurrency[0]?.amountMinor === 0 && s.byCurrency[0]?.foreign?.[0]?.amountMinor === 2_275_000, j(s));
}
{
  const s = await agrees("paid in November", { dateFrom: "2026-11-01", dateTo: "2026-11-30" });
  check("November: 6 payments (not 20 Oct, not 30 Sep)", s.count === 6, String(s.count));
}
{
  const s = await agrees("paid 10–15 Nov", { dateFrom: "2026-11-10", dateTo: "2026-11-15" });
  check("10–15 Nov: card 500, USD card 300, bank 2,000 — the end day counted whole", s.count === 3, j(s));
}
{
  const s = await agrees("from 16 Nov", { dateFrom: "2026-11-16" });
  check("from 16 Nov: the two rupee payments", s.count === 2, j(s));
}
{
  const s = await agrees("search 'alpha'", { q: "alpha" });
  check("search by customer: Alpha's 2 payments, AED 1,500.00 — not the other organization's Alpha", s.count === 2 && s.byCurrency[0]?.amountMinor === 150_000, j(s));
}
{
  const s = await agrees("search 'IN-00003'", { q: "IN-00003" });
  check("search by invoice number: Gamma's USD payment", s.count === 1 && s.byCurrency[0]?.currency === "USD", j(s));
}
{
  const s = await agrees("one invoice", { invoiceId: String(alpha) });
  check("one invoice: its 2 payments", s.count === 2, j(s));
}
{
  const s = await agrees("everything at once", { method: "card", dateFrom: "2026-11-01", dateTo: "2026-11-30", q: "a" });
  check("card + November + 'a': Alpha's card and Gamma's card, AED and USD apart", s.count === 2 && s.byCurrency.length === 2, j(s));
}
{
  const s = await agrees("nothing matches", { q: "no such client" });
  check("nothing matches: zero, no lines", s.count === 0 && s.byCurrency.length === 0, j(s));
}

step("Organizations");
{
  const other = await paymentSummary(String(OTHER), {});
  check("the other organization sees only its own payment", other.count === 1 && other.byCurrency[0]?.amountMinor === 9_999_900, j(other));
  const empty = await paymentSummary(String(EMPTY), {});
  check("an organization with no payments: zeros, not an error", empty.count === 0 && empty.byCurrency.length === 0, j(empty));
}

step("Routing");
{
  const router = (await import("../modules/invoice/payment.routes")).default as unknown as { stack: Array<{ route?: { path: string } }> };
  const paths = router.stack.map((l) => l.route?.path).filter(Boolean);
  check(`"/summary" comes before "/:id" (${paths.join(", ")})`, paths.indexOf("/summary") > -1 && paths.indexOf("/summary") < paths.indexOf("/:id"));
}

await mongoose.disconnect();
console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures ? 1 : 0);
