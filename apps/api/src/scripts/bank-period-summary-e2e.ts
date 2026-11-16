/**
 * A bank account's period totals (the user, 2026-11-16: "when we select a date range, that range's sum also shows in
 * the stats"): GET /bank-accounts/:id/transactions/summary's service against a scratch database.
 *
 * What it proves:
 *   - money in, out and net over the picked days, with how many lines each, and the account's balance before the
 *     first day and after the last — the Balance column's figures, so start + net = end;
 *   - only a From, only a To, no dates; a period before the first line opens at the opening balance;
 *   - status, source and search narrow in/out/net but never the balances; another account's lines never count;
 *   - the list still answers as before with the same filters (they share one filter now).
 *
 * Run through scripts/bank-period-summary-e2e.sh (throwaway mongod, no .env anywhere).
 */
import mongoose, { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}

const { BankAccount } = await import("../modules/banking/bank-account.model");
const { BankTransaction } = await import("../modules/banking/bank-transaction.model");
const svc = await import("../modules/banking/banking.service");
const { bankTransactionQuerySchema } = await import("@delta/shared");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const j = (v: unknown) => JSON.stringify(v);

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();

const ORG = new Types.ObjectId();
const acc = await BankAccount.create({ organizationId: ORG, accountName: "Federal Bank", accountType: "savings", currency: "INR", openingBalanceMinor: 1_000_000, currentBalanceMinor: 1_000_000, openingDate: new Date("2026-08-27") });
const other = await BankAccount.create({ organizationId: ORG, accountName: "Other", accountType: "savings", currency: "INR", openingBalanceMinor: 0, currentBalanceMinor: 0, openingDate: new Date("2026-08-27") });
let seq = 0;
const line = (account: typeof acc, date: string, amountMinor: number, description: string, x: Record<string, unknown> = {}) => ({
  organizationId: ORG, accountId: account._id, accountName: account.accountName, currency: "INR", date: new Date(`${date}T00:00:00.000Z`),
  description, reference: "", amountMinor, type: amountMinor < 0 ? "debit" : "credit", runningBalanceMinor: 0, source: "manual", status: "unmatched",
  createdAt: new Date(Date.UTC(2026, 10, 16, 0, 0, seq++)), updatedAt: new Date(), ...x,
});
// Opening 10,000.00. Before November: +4,000 (Oct 20), −1,000 (Oct 31) → 13,000 when November starts.
await BankTransaction.collection.insertMany([
  line(acc, "2026-10-20", 400_000, "Top-up"),
  line(acc, "2026-10-31", -100_000, "Rent"),
  line(acc, "2026-11-02", -250_000, "meta ads", { status: "matched" }),
  line(acc, "2026-11-04", 150_000, "Refund", { source: "import" }),
  line(acc, "2026-11-04", -50_000, "meta ads", { status: "matched" }),   // same day: after the refund
  line(acc, "2026-11-12", -500_000, "meta ads", { status: "matched" }),
  line(acc, "2026-11-20", 300_000, "Top-up"),
  line(other, "2026-11-05", 999_900, "Elsewhere"),
]);
await svc.recalculateRunningBalances(String(ORG), acc._id);
await svc.recalculateRunningBalances(String(ORG), other._id);
const sum = (q: Record<string, string> = {}) => svc.transactionSummary(String(ORG), String(acc._id), bankTransactionQuerySchema.parse(q));

step("1. A date range");
let s = await sum({ dateFrom: "2026-11-01", dateTo: "2026-11-15" });
check("four lines: in 1,500 (1), out 8,000 (3), net −6,500", s.count === 4 && s.inMinor === 150_000 && s.inCount === 1 && s.outMinor === 800_000 && s.outCount === 3 && s.netMinor === -650_000, j(s));
check("balance 13,000 at the start, 6,500 at the end", s.startBalanceMinor === 1_300_000 && s.endBalanceMinor === 650_000, j(s));
check("start + net = end", s.startBalanceMinor + s.netMinor === s.endBalanceMinor);
check("…the end is the Balance column on the period's last line", (await BankTransaction.findOne({ accountId: acc._id, description: "meta ads", amountMinor: -500_000 }).lean())?.runningBalanceMinor === s.endBalanceMinor);
check("currency and days echoed", s.currency === "INR" && s.dateFrom === "2026-11-01" && s.dateTo === "2026-11-15", j(s));
check("another account's line that day never counts", s.count === 4);

step("2. One end only, none, before the first line");
s = await sum({ dateFrom: "2026-11-05" });
check("from 5 Nov: two lines, start 11,500, end today's 9,500", s.count === 2 && s.startBalanceMinor === 1_150_000 && s.endBalanceMinor === 950_000 && s.netMinor === -200_000, j(s));
s = await sum({ dateTo: "2026-10-31" });
check("up to 31 Oct: start at the opening 10,000, end 13,000", s.count === 2 && s.startBalanceMinor === 1_000_000 && s.endBalanceMinor === 1_300_000 && s.netMinor === 300_000, j(s));
s = await sum({});
check("no dates: everything, opening 10,000 to today's 9,500", s.count === 7 && s.startBalanceMinor === 1_000_000 && s.endBalanceMinor === 950_000 && s.startBalanceMinor + s.netMinor === s.endBalanceMinor, j(s));
s = await sum({ dateFrom: "2026-09-01", dateTo: "2026-09-30" });
check("a period with nothing in it: zeros, opening balance at both ends", s.count === 0 && s.netMinor === 0 && s.startBalanceMinor === 1_000_000 && s.endBalanceMinor === 1_000_000, j(s));
s = await sum({ dateFrom: "2026-11-04", dateTo: "2026-11-04" });
check("one day with two lines: both counted, start before the first, end after the last", s.count === 2 && s.startBalanceMinor === 1_050_000 && s.endBalanceMinor === 1_150_000, j(s));

step("3. Other filters");
s = await sum({ dateFrom: "2026-11-01", dateTo: "2026-11-15", status: "matched" });
check("status Matched: only the three ads — out 8,000, no money in", s.count === 3 && s.outMinor === 800_000 && s.inMinor === 0, j(s));
check("…the balances are still the account's", s.startBalanceMinor === 1_300_000 && s.endBalanceMinor === 650_000, j(s));
s = await sum({ dateFrom: "2026-11-01", dateTo: "2026-11-15", source: "import" });
check("source Imported: the refund only", s.count === 1 && s.inMinor === 150_000, j(s));
s = await sum({ dateFrom: "2026-11-01", dateTo: "2026-11-15", q: "meta" });
check("search \"meta\": the three ads", s.count === 3 && s.outMinor === 800_000, j(s));

step("4. The list with the same filters");
const list = await svc.listTransactions(String(ORG), String(acc._id), bankTransactionQuerySchema.parse({ dateFrom: "2026-11-01", dateTo: "2026-11-15", pageSize: "2" }));
check("still pages: 2 of 4, newest first", list.data.length === 2 && list.meta.total === 4 && list.data[0]!.date.slice(0, 10) === "2026-11-12", j({ total: list.meta.total, first: list.data[0]?.date }));
const matched = await svc.listTransactions(String(ORG), String(acc._id), bankTransactionQuerySchema.parse({ status: "matched", q: "meta" }));
check("status + search: the three ads", matched.meta.total === 3);
check("an account that isn't there: NOT_FOUND", await svc.transactionSummary(String(ORG), String(new Types.ObjectId()), bankTransactionQuerySchema.parse({})).then(() => false, (e: { code?: string }) => e.code === "NOT_FOUND"));

await mongoose.disconnect();
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
