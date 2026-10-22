/**
 * The Invoices and Expenses lists' "Paid by" and "Bank account" filters (the user, 2026-10-22: "on invoice and
 * expense we need filter for the payment mode with bank filter") — listInvoices, invoiceListSummary, listExpenses and
 * expenseSummary against a scratch database.
 *
 * What it proves:
 *   - an invoice matches when any of its payments was by that method, or into that account;
 *   - both on the same payment: "by card into Delta Bank" is not an invoice paid by card into Petty and by cash into Delta Bank;
 *   - an older payment with only the account's name typed (no link) is found by that account;
 *   - "No account" finds the payments, and expenses, in no account;
 *   - an expense matches by its method and its account (link, or name on an older one);
 *   - another organization's account of the same name is never matched;
 *   - the cards count what the table lists, under these filters too.
 *
 * Run through scripts/payment-filters-e2e.sh (throwaway mongod, no .env anywhere).
 */
import mongoose, { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}

const { Invoice } = await import("../modules/invoice/invoice.model");
const { Expense } = await import("../modules/expense/expense.model");
const { BankAccount } = await import("../modules/banking/bank-account.model");
const inv = await import("../modules/invoice/invoice.service");
const ex = await import("../modules/expense/expense.service");
const { invoiceQuerySchema, expenseQuerySchema } = await import("@delta/shared");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const j = (v: unknown) => String(JSON.stringify(v)).slice(0, 600);

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();

const ORG = new Types.ObjectId(), OTHER = new Types.ObjectId(), anna = new Types.ObjectId();
const account = async (org: Types.ObjectId, name: string, type = "current") => (await BankAccount.collection.insertOne({
  organizationId: org, accountName: name, accountType: type, currency: "AED", currentBalanceMinor: 0, openingBalanceMinor: 0,
  openingDate: new Date("2026-01-01"), isActive: true, createdAt: new Date(), updatedAt: new Date(),
})).insertedId;
const BANK = await account(ORG, "Delta Bank"), PETTY = await account(ORG, "Delta Petty", "petty_cash");
const ELSEWHERE = await account(OTHER, "Delta Bank");

type Pay = { method: string; bank?: Types.ObjectId | null; name?: string };
const pay = (p: Pay) => ({
  _id: new Types.ObjectId(), method: p.method, amountMinor: 10_000, paidOn: new Date("2026-10-20"), reference: "", notes: "",
  accountName: p.name ?? (p.bank === BANK ? "Delta Bank" : p.bank === PETTY ? "Delta Petty" : ""), bankAccountId: p.bank ?? null,
  createdAt: new Date(), updatedAt: new Date(),
});
let n = 0;
const invoice = (payments: Pay[], org = ORG) => Invoice.collection.insertOne({
  organizationId: org, invoiceNumber: `IN-${String(++n).padStart(5, "0")}`, customerId: new Types.ObjectId(), customerName: `Client ${n}`,
  salespersonId: anna, salespersonName: "Anna", issueDate: new Date("2026-10-20"), dueDate: new Date("2999-01-01"), currency: "AED",
  status: payments.length ? "paid" : "sent", totalMinor: 10_000 * Math.max(1, payments.length), amountPaidMinor: 10_000 * payments.length,
  balanceMinor: payments.length ? 0 : 10_000, lineItems: [], payments: payments.map(pay), createdAt: new Date(), updatedAt: new Date(),
});
await invoice([{ method: "card", bank: BANK }]);                                       // IN-00001 card → Delta Bank
await invoice([{ method: "tabby", bank: BANK }, { method: "cash", bank: PETTY }]);     // IN-00002 Tabby → Bank, cash → Petty
await invoice([{ method: "card", bank: PETTY }, { method: "cash", bank: BANK }]);      // IN-00003 card → Petty, cash → Bank
await invoice([{ method: "bank_transfer", bank: null, name: "Delta Bank" }]);          // IN-00004 older: name only
await invoice([{ method: "cash", bank: null }]);                                       // IN-00005 in no account
await invoice([]);                                                                     // IN-00006 nothing paid
await invoice([{ method: "card", bank: ELSEWHERE, name: "Delta Bank" }], OTHER);       // another organization

const ALL = { all: true } as never;
const iq = (over: Record<string, unknown>) => invoiceQuerySchema.parse({ page: 1, pageSize: 100, ...over }) as never;
const numbers = async (label: string, over: Record<string, unknown>, want: string[]) => {
  const [list, s] = await Promise.all([inv.listInvoices(String(ORG), iq(over), ALL), inv.invoiceListSummary(String(ORG), iq(over), ALL)]);
  const got = list.data.map((r) => r.invoiceNumber).sort();
  check(`${label}: ${want.join(", ") || "none"}`, j(got) === j(want), j(got));
  check(`${label}: the cards count the same (${s.count})`, s.count === list.meta.total, j([s.count, list.meta.total]));
};

/* ── 1 ── */
step("1. Invoices");
await numbers("Paid by card", { paymentMethod: "card" }, ["IN-00001", "IN-00003"]);
await numbers("Into Delta Bank (linked, and the older one by name)", { bankAccountId: String(BANK) }, ["IN-00001", "IN-00002", "IN-00003", "IN-00004"]);
await numbers("Into Delta Petty", { bankAccountId: String(PETTY) }, ["IN-00002", "IN-00003"]);
await numbers("By card into Delta Bank — the same payment", { paymentMethod: "card", bankAccountId: String(BANK) }, ["IN-00001"]);
await numbers("By cash into Delta Bank", { paymentMethod: "cash", bankAccountId: String(BANK) }, ["IN-00003"]);
await numbers("In no account", { bankAccountId: "none" }, ["IN-00005"]);
await numbers("Another organization's account", { bankAccountId: String(ELSEWHERE) }, []);
const bad = invoiceQuerySchema.safeParse({ bankAccountId: "x" });
check("an account that is not an id is refused", !bad.success);
const badMethod = invoiceQuerySchema.safeParse({ paymentMethod: "bitcoin" });
check("a method that is not one is refused", !badMethod.success);

/* ── 2 ── */
step("2. Expenses");
let e = 0;
const expense = (method: string | undefined, bank: Types.ObjectId | null, name: string, org = ORG) => Expense.collection.insertOne({
  organizationId: org, expenseNumber: `EXP-${++e}`, category: "other_unclassified", description: `Expense ${e}`, expenseDate: new Date("2026-10-20"),
  amountMinor: 1_000, totalMinor: 1_000, currency: "AED", submittedById: anna, submittedByName: "Anna", status: "approved",
  ...(method ? { paymentMethod: method } : {}), bankAccountId: bank, paymentAccount: name, createdAt: new Date(), updatedAt: new Date(),
});
await expense("card", BANK, "Delta Bank");            // EXP-1
await expense("cash", PETTY, "Delta Petty");          // EXP-2
await expense("bank_transfer", null, "Delta Bank");   // EXP-3 older: name only
await expense(undefined, null, "");                   // EXP-4 nothing said
await expense("card", ELSEWHERE, "Delta Bank", OTHER); // another organization
const eq = (over: Record<string, unknown>) => expenseQuerySchema.parse({ page: 1, pageSize: 100, ...over }) as never;
const exps = async (label: string, over: Record<string, unknown>, want: string[]) => {
  const [list, s] = await Promise.all([ex.listExpenses(String(ORG), eq(over), ALL), ex.expenseSummary(String(ORG), eq(over), ALL)]);
  const got = list.data.map((r) => r.expenseNumber).sort();
  check(`${label}: ${want.join(", ") || "none"}`, j(got) === j(want), j(got));
  check(`${label}: the cards count the same (${s.count})`, s.count === list.meta.total, j([s.count, list.meta.total]));
};
await exps("Paid by card", { paymentMethod: "card" }, ["EXP-1"]);
await exps("From Delta Bank (linked, and the older one by name)", { bankAccountId: String(BANK) }, ["EXP-1", "EXP-3"]);
await exps("From Delta Petty", { bankAccountId: String(PETTY) }, ["EXP-2"]);
await exps("By card from Delta Petty", { paymentMethod: "card", bankAccountId: String(PETTY) }, []);
await exps("From no account", { bankAccountId: "none" }, ["EXP-4"]);
await exps("Another organization's account", { bankAccountId: String(ELSEWHERE) }, []);
await exps("No filter", {}, ["EXP-1", "EXP-2", "EXP-3", "EXP-4"]);

console.log(`\n${checks - failures}/${checks} passed`);
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
