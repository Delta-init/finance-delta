/**
 * One organization's payments put in its Banking accounts (the user, 2026-10-16: "if payment method is cash its bank
 * will be petty … backfill current payments also including expense, invoice and others" — Delta HQ only).
 *
 *   1. Where payments go (Settings): each --map method=Account sets that method's account.
 *   2. Invoice payments in no account: their method's account (as mapped), and their line there — a credit, with a
 *      charges debit when they have charges (invoice/payment-bank.ts). A method left unmapped ("other") is left.
 *   3. Expenses (not voided or rejected) in no account: --text-account <name> for those whose typed "Payment Account /
 *      Bank" names a bank ("Bank", "ADCB", "Delta Bank"…), else their method's; a paid one gets its money-out line.
 *   4. Bill payments in no account: their method's, and their money-out line.
 *
 * Reads and prints only, unless --write. Run it from apps/api on the server (Bun reads MONGODB_URI from the .env), after
 * the API with this change is deployed:
 *
 *   bun src/scripts/bank-accounts-backfill.ts --org <id> --map cash="Delta Petty" --map tabby="Delta Bank" … \
 *       --text-account "Delta Bank"                                  # what it would do
 *   … --write --expect <N>                                           # do it, N as the dry run counted
 *
 * Before writing, what it changes is saved to backups/bank-accounts-<time>.json beside apps/api. Safe to run again: what
 * is already in an account is left alone.
 */
import fs from "node:fs";
import path from "node:path";
import mongoose, { Types } from "mongoose";
import { Organization } from "../modules/organization/organization.model";
import { BankAccount } from "../modules/banking/bank-account.model";
import { Invoice } from "../modules/invoice/invoice.model";
import { Expense } from "../modules/expense/expense.model";
import { Bill } from "../modules/bill/bill.model";
import { stampAccount, syncPaymentLine } from "../modules/invoice/payment-bank";
import { syncExpenseLine } from "../modules/expense/expense.service";

export interface Plan {
  mapping: { method: string; from: string; to: string }[];
  invoicePayments: { invoiceId: string; invoiceNumber: string; paymentId: string; method: string; amount: string; account: string }[];
  expenses: { id: string; expenseNumber: string; status: string; paid: boolean; typed: string; account: string }[];
  billPayments: { billId: string; billNumber: string; paymentId: string; method: string; account: string }[];
  unknownAccounts: string[];
}

const money = (minor: number, cur: string) => `${cur} ${(minor / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

export async function backfillBankAccounts(opts: {
  orgId: string; map: Record<string, string>; textAccount?: string; write: boolean; backupDir?: string;
}): Promise<Plan> {
  const org = await Organization.findById(opts.orgId).lean<any>();
  if (!org) throw new Error(`No organization ${opts.orgId}`);
  const accounts = await BankAccount.find({ organizationId: org._id }).select("accountName currency isActive").lean<any[]>();
  const byName = new Map(accounts.filter((a) => a.isActive !== false).map((a) => [String(a.accountName).trim().toLowerCase(), a]));
  const nameOf = new Map(accounts.map((a) => [String(a._id), String(a.accountName)]));
  const plan: Plan = { mapping: [], invoicePayments: [], expenses: [], billPayments: [], unknownAccounts: [] };

  // 1. Where payments go.
  const current: Record<string, string> = { ...(org.paymentAccounts ?? {}) };
  const wanted: Record<string, string> = { ...current };
  for (const [method, name] of Object.entries(opts.map)) {
    const acc = byName.get(name.trim().toLowerCase());
    if (!acc) { plan.unknownAccounts.push(name); continue; }
    if (current[method] !== String(acc._id)) {
      plan.mapping.push({ method, from: current[method] ? nameOf.get(current[method]!) ?? current[method]! : "—", to: acc.accountName });
      wanted[method] = String(acc._id);
    }
  }
  const textAcc = opts.textAccount ? byName.get(opts.textAccount.trim().toLowerCase()) : null;
  if (opts.textAccount && !textAcc) plan.unknownAccounts.push(opts.textAccount);
  const accountFor = (method?: string) => (method && wanted[method] ? accounts.find((a) => String(a._id) === wanted[method]) : null);

  // 2. Invoice payments in no account.
  const invoices = await Invoice.find({ organizationId: org._id, "payments.0": { $exists: true } })
    .select("invoiceNumber currency payments status").lean<any[]>();
  for (const inv of invoices) {
    for (const p of inv.payments ?? []) {
      if (p.bankAccountId) continue;
      const acc = accountFor(p.method);
      if (!acc) continue;
      plan.invoicePayments.push({ invoiceId: String(inv._id), invoiceNumber: inv.invoiceNumber, paymentId: String(p._id), method: p.method,
        amount: money(p.amountMinor ?? 0, inv.currency ?? "AED"), account: acc.accountName });
    }
  }

  // 3. Expenses in no account.
  // Never the old books' imported rows (2026-10-21): they stay out of the cash books.
  const expenses = await Expense.find({ organizationId: org._id, status: { $nin: ["voided", "rejected"] }, bankAccountId: { $in: [null, undefined] }, "source.kind": { $ne: "import" } })
    .select("expenseNumber status paidOn paymentMethod paymentAccount").lean<any[]>();
  for (const e of expenses) {
    const typed = String(e.paymentAccount ?? "").trim();
    const acc = typed && textAcc && /bank|adcb/i.test(typed) ? textAcc : accountFor(e.paymentMethod);
    if (!acc) continue;
    plan.expenses.push({ id: String(e._id), expenseNumber: e.expenseNumber, status: e.status, paid: !!e.paidOn, typed, account: acc.accountName });
  }

  // 4. Bill payments in no account.
  const bills = await Bill.find({ organizationId: org._id, "payments.0": { $exists: true } }).select("billNumber payments").lean<any[]>();
  for (const b of bills) {
    for (const p of b.payments ?? []) {
      if (p.bankAccountId) continue;
      const acc = accountFor(p.method);
      if (acc) plan.billPayments.push({ billId: String(b._id), billNumber: b.billNumber, paymentId: String(p._id), method: p.method, account: acc.accountName });
    }
  }

  if (!opts.write) return plan;
  if (!plan.unknownAccounts.length && !count(plan)) return plan;
  if (plan.unknownAccounts.length) throw new Error(`No open account called ${plan.unknownAccounts.join(", ")} in ${org.name} — nothing written`);

  // What is about to change, read back whole before anything does.
  const dir = opts.backupDir ?? path.resolve(process.cwd(), "backups");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `bank-accounts-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  const backup = {
    at: new Date().toISOString(), organizationId: String(org._id), paymentAccounts: current,
    invoices: invoices.filter((i) => plan.invoicePayments.some((p) => p.invoiceId === String(i._id))).map((i) => ({ _id: i._id, payments: i.payments })),
    expenses: plan.expenses.map((e) => e.id),
    bills: bills.filter((b) => plan.billPayments.some((p) => p.billId === String(b._id))).map((b) => ({ _id: b._id, payments: b.payments })),
  };
  fs.writeFileSync(file, JSON.stringify(backup, null, 2));
  const back = JSON.parse(fs.readFileSync(file, "utf8"));
  if (back.invoices.length !== backup.invoices.length || back.expenses.length !== backup.expenses.length) throw new Error(`The backup ${file} did not read back whole — nothing written`);
  console.log(`Backup: ${file}`);

  if (plan.mapping.length) await Organization.updateOne({ _id: org._id }, { $set: { paymentAccounts: wanted } });

  for (const row of plan.invoicePayments) {
    const inv = invoices.find((i) => String(i._id) === row.invoiceId)!;
    const p = inv.payments.find((x: any) => String(x._id) === row.paymentId);
    const acc = accountFor(p.method)!;
    const target: Record<string, unknown> = { amountMinor: p.amountMinor, chargesMinor: p.chargesMinor ?? 0, bankAmountMinor: null };
    stampAccount(target, acc as never, inv.currency ?? "AED", null);
    await Invoice.updateOne({ _id: inv._id, "payments._id": p._id, "payments.bankAccountId": { $in: [null, undefined] } }, { $set: {
      "payments.$.bankAccountId": target.bankAccountId, "payments.$.accountName": target.accountName, "payments.$.bankCurrency": target.bankCurrency,
      "payments.$.bankAmountMinor": target.bankAmountMinor ?? null, "payments.$.bankNote": target.bankNote ?? "",
    } });
    await syncPaymentLine({ _id: inv._id, organizationId: org._id } as never, p._id);
  }

  for (const row of plan.expenses) {
    const acc = byName.get(row.account.trim().toLowerCase())!;
    await Expense.updateOne({ _id: new Types.ObjectId(row.id), bankAccountId: { $in: [null, undefined] } }, { $set: { bankAccountId: acc._id, paymentAccount: acc.accountName } });
    await syncExpenseLine(String(org._id), row.id);
  }

  for (const row of plan.billPayments) {
    const acc = byName.get(row.account.trim().toLowerCase())!;
    await Bill.updateOne({ _id: new Types.ObjectId(row.billId), "payments._id": new Types.ObjectId(row.paymentId) },
      { $set: { "payments.$.bankAccountId": acc._id, "payments.$.accountName": acc.accountName } });
    // The bill's own sync is private to its service; its edit path is the one the page uses.
    const { resyncBillPaymentLine } = await import("../modules/bill/bill.service");
    await resyncBillPaymentLine(String(org._id), row.billId, row.paymentId);
  }
  return plan;
}

const count = (p: Plan) => p.mapping.length + p.invoicePayments.length + p.expenses.length + p.billPayments.length;

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const arg = (k: string) => { const i = argv.indexOf(k); return i > -1 ? argv[i + 1] : undefined; };
  const map: Record<string, string> = {};
  argv.forEach((a, i) => { if (a === "--map" && argv[i + 1]?.includes("=")) { const [m, ...n] = argv[i + 1]!.split("="); map[m!.trim()] = n.join("=").trim(); } });
  const orgId = arg("--org");
  if (!orgId || !Types.ObjectId.isValid(orgId)) { console.error("--org <organization id> is required"); process.exit(1); }
  const write = argv.includes("--write");
  const { connectDb } = await import("../config/db");
  await connectDb();
  const dry = await backfillBankAccounts({ orgId, map, textAccount: arg("--text-account"), write: false });
  const print = (p: Plan) => {
    for (const m of p.mapping) console.log(`where payments go  ${m.method.padEnd(18)} ${m.from} → ${m.to}`);
    for (const r of p.invoicePayments) console.log(`invoice payment    ${r.invoiceNumber.padEnd(12)} ${r.method.padEnd(18)} ${r.amount.padStart(16)} → ${r.account}`);
    for (const r of p.expenses) console.log(`expense            ${r.expenseNumber.padEnd(12)} ${r.status.padEnd(10)} ${r.paid ? "paid  " : "unpaid"} typed "${r.typed}" → ${r.account}${r.paid ? " (money-out line)" : ""}`);
    for (const r of p.billPayments) console.log(`bill payment       ${r.billNumber.padEnd(12)} ${r.method.padEnd(18)} → ${r.account}`);
    if (p.unknownAccounts.length) console.log(`\nNO OPEN ACCOUNT CALLED: ${p.unknownAccounts.join(", ")}`);
  };
  if (write) {
    const expect = Number(arg("--expect"));
    if (expect !== count(dry)) {
      print(dry);
      console.error(`\nRefusing to write: ${count(dry)} change(s), and --expect ${arg("--expect") ?? "(missing)"} was given.`);
      await mongoose.disconnect();
      process.exit(1);
    }
    const done = await backfillBankAccounts({ orgId, map, textAccount: arg("--text-account"), write: true });
    print(done);
    console.log(`\n${count(done)} change(s) written.`);
  } else {
    print(dry);
    console.log(`\n${count(dry)} change(s): ${dry.mapping.length} setting(s), ${dry.invoicePayments.length} invoice payment(s), ${dry.expenses.length} expense(s), ${dry.billPayments.length} bill payment(s). Nothing written — run again with --write --expect ${count(dry)}.`);
  }
  await mongoose.disconnect();
}
