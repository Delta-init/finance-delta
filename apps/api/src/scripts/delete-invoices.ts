/**
 * Invoices taken off the books for good, their payments with them (the user, 2026-10-22: "delete those invoices —
 * IN-00081, IN-00014 — their payment history also").
 *
 * Done the way the invoice page does it, one step at a time, so nothing is left behind: each payment is deleted with
 * finance's own deletePayment (its bank / cash line goes and the account's balance is worked out again; Tetra
 * Commission is told the fee moved), the invoice's commission records go (not one already paid out), then the
 * invoice itself with deleteInvoice (its pending LMS provisioning and instalment reminders go; Tetra Commission is
 * told). What another system has already done stays done — a student's LMS access and Tetra Commission account are
 * removed by hand. The emails log keeps its lines.
 *
 * Refused, and nothing written, when any of them has something that must be dealt with first: a credit note, a
 * balance payment from a sales CRM, a Tetra Commission payment, a quotation converted into it, a commission already
 * paid out, a payment whose bank line was reconciled to a statement, or a payment on a voided invoice — and one
 * Tetra Commission has, run where Tetra Commission is not set up (it could not be told: run it on the server).
 *
 * Reads and prints only, unless --write. Run it from apps/api on the server (Bun reads MONGODB_URI from the .env):
 *
 *   bun src/scripts/delete-invoices.ts IN-00081 IN-00014                    # what it would delete
 *   bun src/scripts/delete-invoices.ts IN-00081 IN-00014 --write --expect 2 # do it, 2 invoices as counted
 *   bun src/scripts/delete-invoices.ts --undo backups/delete-invoices-<time>.json [--write]
 *   … --org <organization id>   when a number is used in more than one organization
 *   … --backups <folder>        where the backup goes (backups/ beside apps/api unless given)
 *
 * Before deleting, everything it removes is saved to backups/delete-invoices-<time>.json beside apps/api; --undo puts
 * it back — the invoices with their payments, their bank lines (balances worked out again), commission records,
 * LMS provisioning and reminders. Tetra Commission is not told again on an undo.
 */
import fs from "node:fs";
import path from "node:path";
import mongoose, { Types } from "mongoose";
import { formatMoney, paymentMethodLabel } from "@delta/shared";
import { Organization } from "../modules/organization/organization.model";
import { Invoice } from "../modules/invoice/invoice.model";
import { BankTransaction } from "../modules/banking/bank-transaction.model";
import { CommissionRecord } from "../modules/commission/commission-record.model";
import { CreditNote } from "../modules/credit-note/credit-note.model";
import { Quotation } from "../modules/quotation/quotation.model";
import { BalancePaymentModel } from "../modules/balance-payment/balance-payment.model";
import { TetraDepositModel } from "../modules/tetra-deposit/tetra-deposit.model";
import { LmsProvision } from "../modules/integrations/lms-provision.model";
import { InstalmentReminder } from "../modules/invoice/instalment-reminder.model";
import { commissionConfigured } from "../lib/commission-client";

const { EJSON } = mongoose.mongo.BSON;
const day = (d: unknown) => (d ? new Date(d as string).toISOString().slice(0, 10) : "—");

export interface InvoicePlan {
  id: string;
  orgId: string;
  org: string;
  number: string;
  customer: string;
  status: string;
  total: string;
  paid: string;
  crm: string;
  payments: string[];
  commissions: string[];
  lms: string;
  reminders: number;
  problems: string[];
}

export interface DeletePlan {
  invoices: InvoicePlan[];
  problems: string[];
  backup?: string;
}

/** What deleting these invoice numbers would take with it, and what stands in the way. */
export async function planDelete(numbers: string[], orgId?: string): Promise<DeletePlan> {
  const problems: string[] = [];
  const invoices: InvoicePlan[] = [];
  const orgName = new Map<string, string>();
  for (const number of numbers) {
    const found = await Invoice.find({ invoiceNumber: number, ...(orgId ? { organizationId: new Types.ObjectId(orgId) } : {}) }).lean<any[]>();
    if (found.length === 0) { problems.push(`${number}: no such invoice${orgId ? " in that organization" : ""}`); continue; }
    if (found.length > 1) { problems.push(`${number}: in ${found.length} organizations — say which with --org`); continue; }
    const inv = found[0];
    const id = inv._id as Types.ObjectId;
    const org = String(inv.organizationId);
    if (!orgName.has(org)) orgName.set(org, (await Organization.findById(org).select("name").lean<any>())?.name ?? org);
    const cur = inv.currency ?? "AED";
    const mine: string[] = [];

    const lineIds = (inv.payments ?? []).flatMap((p: any) => [p.bankTransactionId, p.bankChargesTransactionId]).filter(Boolean);
    const lines = new Map((await BankTransaction.find({ _id: { $in: lineIds } }).select("accountName isReconciled").lean<any[]>()).map((t) => [String(t._id), t]));
    const payments = (inv.payments ?? []).map((p: any) => {
      const line = p.bankTransactionId ? lines.get(String(p.bankTransactionId)) : null;
      if (line?.isReconciled) mine.push(`the ${formatMoney(p.amountMinor ?? 0, cur)} payment of ${day(p.paidOn)} is in a reconciled statement line in ${line.accountName}`);
      return `${day(p.paidOn)}  ${(paymentMethodLabel(p.method) || p.method || "").padEnd(16)} ${formatMoney(p.amountMinor ?? 0, cur).padStart(14)}  ${line ? `→ line in ${line.accountName}` : "no bank line"}${p.receiptNumber ? `  ${p.receiptNumber}` : ""}`;
    });
    if ((inv.payments ?? []).length && inv.status === "void") mine.push("it is voided with payments on it — restore it first, or delete the payments by hand");

    const commissions = await CommissionRecord.find({ invoiceId: id }).lean<any[]>();
    for (const c of commissions) if (c.status === "paid") mine.push(`a commission of ${formatMoney(c.commissionMinor ?? 0, cur)} (${c.salespersonName}) from it was already paid out`);
    const [credited, quoted, balance, deposit] = await Promise.all([
      CreditNote.exists({ invoiceId: id }),
      Quotation.exists({ $or: [{ "convertedTo.invoiceId": id }, { "convertedTo.invoiceIds": id }] }),
      BalancePaymentModel.exists({ invoiceId: id }),
      // A deleted deposit (Tetra Deposits → Delete) no longer holds its invoice.
      TetraDepositModel.exists({ status: { $ne: "deleted" }, $or: [{ "courseInvoice.invoiceId": id }, { "enrolmentPayment.invoiceId": id }] }),
    ]);
    if (credited) mine.push("a credit note refers to it");
    if (quoted) mine.push("a quotation was converted into it");
    if (balance) mine.push("a balance payment from a sales CRM refers to it");
    if (deposit) mine.push("a Tetra Commission payment refers to it");

    const lms = await LmsProvision.findOne({ invoiceId: id }).select("status commission.state").lean<any>();
    const inTetra = lms?.commission?.state === "sent";
    if (inTetra && !commissionConfigured()) mine.push("Tetra Commission has this enrolment, and it cannot be told from here (no COMMISSION_API_URL) — run this on the server");
    const reminders = await InstalmentReminder.countDocuments({ invoiceId: id });
    for (const m of mine) problems.push(`${number}: ${m}`);
    invoices.push({
      id: String(id), orgId: org, org: orgName.get(org)!, number, customer: inv.customerName ?? "", status: inv.status,
      total: formatMoney(inv.totalMinor ?? 0, cur), paid: formatMoney(inv.amountPaidMinor ?? 0, cur),
      crm: inv.enrolment?.crm ? `from the ${inv.enrolment.crm} CRM` : "typed in finance",
      payments, commissions: commissions.map((c) => `${c.salespersonName} ${formatMoney(c.commissionMinor ?? 0, cur)} (${c.status})`),
      lms: (!lms ? "none" : lms.status === "sent" ? "sent — the student's LMS access stays; remove it in the LMS" : `${lms.status} — removed`)
        + (inTetra ? "; Tetra Commission has it — it is told the invoice is gone (the student's account there stays)" : ""),
      reminders, problems: mine,
    });
  }
  return { invoices, problems };
}

/** Deletes them, after saving all it removes; refuses when the plan has problems. */
export async function runDelete(numbers: string[], opts: { orgId?: string; backupDir?: string } = {}): Promise<DeletePlan> {
  const plan = await planDelete(numbers, opts.orgId);
  if (plan.problems.length) return plan;
  const ids = plan.invoices.map((i) => new Types.ObjectId(i.id));
  const invoices = await Invoice.find({ _id: { $in: ids } }).lean<any[]>();
  const lineIds = invoices.flatMap((inv) => (inv.payments ?? []).flatMap((p: any) => [p.bankTransactionId, p.bankChargesTransactionId])).filter(Boolean);
  const saved = {
    made: new Date().toISOString(),
    numbers,
    invoices,
    bankTransactions: await BankTransaction.find({ _id: { $in: lineIds } }).lean(),
    commissionRecords: await CommissionRecord.find({ invoiceId: { $in: ids } }).lean(),
    lmsProvisions: await LmsProvision.find({ invoiceId: { $in: ids }, status: { $ne: "sent" } }).lean(),
    instalmentReminders: await InstalmentReminder.find({ invoiceId: { $in: ids } }).lean(),
  };
  const dir = opts.backupDir ?? path.resolve(process.cwd(), "backups");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `delete-invoices-${saved.made.replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, EJSON.stringify(saved, { relaxed: false }));
  // Read back whole before anything goes.
  const check = EJSON.parse(fs.readFileSync(file, "utf8")) as typeof saved;
  if (check.invoices.length !== invoices.length) throw new Error(`The backup ${file} did not read back whole — nothing deleted`);

  const svc = await import("../modules/invoice/invoice.service");
  for (const inv of invoices) {
    const orgId = String(inv.organizationId);
    for (const p of inv.payments ?? []) await svc.deletePayment(orgId, String(inv._id), String(p._id));
    await CommissionRecord.deleteMany({ invoiceId: inv._id, status: { $ne: "paid" } });
    await svc.deleteInvoice(orgId, String(inv._id));
  }
  return { ...plan, backup: file };
}

/** Puts back what a backup holds — what is already there again is left as it is. */
export async function undoDelete(file: string, write: boolean): Promise<string[]> {
  const saved = EJSON.parse(fs.readFileSync(file, "utf8")) as {
    invoices: any[]; bankTransactions: any[]; commissionRecords: any[]; lmsProvisions: any[]; instalmentReminders: any[];
  };
  const out: string[] = [];
  const missing = async (Model: any, docs: any[]) => {
    const there = new Set((await Model.find({ _id: { $in: docs.map((d) => d._id) } }).select("_id").lean()).map((d: any) => String(d._id)));
    return docs.filter((d) => !there.has(String(d._id)));
  };
  const invoices = await missing(Invoice, saved.invoices);
  const lines = await missing(BankTransaction, saved.bankTransactions);
  const commissions = await missing(CommissionRecord, saved.commissionRecords);
  const provisions = await missing(LmsProvision, saved.lmsProvisions);
  const reminders = await missing(InstalmentReminder, saved.instalmentReminders);
  out.push(`To put back: ${invoices.length} invoice(s) [${invoices.map((i) => i.invoiceNumber).join(", ")}] with ${invoices.reduce((n, i) => n + (i.payments?.length ?? 0), 0)} payment(s); `
    + `${lines.length} bank line(s); ${commissions.length} commission record(s); ${provisions.length} LMS provisioning; ${reminders.length} reminder(s)`);
  if (!write) return out;
  if (invoices.length) await Invoice.collection.insertMany(invoices);
  if (lines.length) await BankTransaction.collection.insertMany(lines);
  if (commissions.length) await CommissionRecord.collection.insertMany(commissions);
  if (provisions.length) await LmsProvision.collection.insertMany(provisions);
  if (reminders.length) await InstalmentReminder.collection.insertMany(reminders);
  const { recalculateRunningBalances } = await import("../modules/banking/banking.service");
  const accounts = new Map(lines.map((l) => [String(l.accountId), { org: String(l.organizationId), id: l.accountId as Types.ObjectId }]));
  for (const a of accounts.values()) await recalculateRunningBalances(a.org, a.id);
  out.push(`Put back. ${accounts.size} account balance(s) worked out again. Tetra Commission was not told — the invoices there may need re-sending.`);
  return out;
}

function print(p: DeletePlan) {
  for (const i of p.invoices) {
    console.log(`\n== ${i.number} · ${i.customer} · ${i.org} (${i.orgId})`);
    console.log(`   ${i.status}, ${i.total}, paid ${i.paid} — ${i.crm}`);
    console.log(`   payments (${i.payments.length}):${i.payments.length ? "" : " none"}`);
    for (const l of i.payments) console.log(`     ${l}`);
    console.log(`   commission records: ${i.commissions.length ? i.commissions.join("; ") : "none"}`);
    console.log(`   LMS provisioning: ${i.lms}; instalment reminders: ${i.reminders}`);
    for (const pr of i.problems) console.log(`   PROBLEM: ${pr}`);
  }
  for (const pr of p.problems.filter((x) => !p.invoices.some((i) => x.startsWith(`${i.number}:`)))) console.log(`\nPROBLEM: ${pr}`);
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const arg = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const write = argv.includes("--write");
  const { connectDb } = await import("../config/db");
  await connectDb();

  const undo = arg("--undo");
  if (undo) {
    for (const l of await undoDelete(undo, write)) console.log(l);
    if (!write) console.log("\nNothing written — run again with --write.");
    await mongoose.disconnect();
    process.exit(0);
  }
  const skip = new Set(["--org", "--expect", "--backups"].flatMap((f) => [f, arg(f)]).filter(Boolean) as string[]);
  const numbers = argv.filter((a) => !a.startsWith("--") && !skip.has(a));
  if (!numbers.length) { console.error("Give the invoice numbers, e.g. IN-00081 IN-00014"); process.exit(1); }

  const dry = await planDelete(numbers, arg("--org"));
  print(dry);
  if (dry.problems.length) {
    console.log("\nNothing deleted — deal with the problems above first.");
  } else if (!write) {
    console.log(`\n${dry.invoices.length} invoice(s) to delete. Nothing deleted — run again with --write --expect ${dry.invoices.length}.`);
  } else if (Number(arg("--expect")) !== dry.invoices.length) {
    console.error(`\nRefusing to delete: ${dry.invoices.length} invoice(s), and --expect ${arg("--expect") ?? "(missing)"} was given.`);
    await mongoose.disconnect();
    process.exit(1);
  } else {
    const done = await runDelete(numbers, { orgId: arg("--org"), backupDir: arg("--backups") });
    console.log(`\n${done.invoices.length} invoice(s) deleted with their payments. Backup: ${done.backup}\nUndo: bun src/scripts/delete-invoices.ts --undo ${done.backup} --write`);
  }
  await mongoose.disconnect();
}
