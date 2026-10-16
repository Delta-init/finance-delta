/**
 * Existing payments with charges: their bank line as two (the user, 2026-10-16:
 * "show as two lines, one the actual amount and the charges minus").
 *
 * Since 2026-10-16 a payment with charges has a credit of the full payment, as
 * the invoice shows it, and a debit of its charges (modules/invoice/payment-bank.ts)
 * — before, one line of the payment less its charges. This brings every payment
 * already in an account into that shape: its single net line is replaced by the
 * two. The account's balance does not change.
 *
 * Left alone: a payment whose line was reconciled against a bank statement (a
 * petty cash tin's is not counted as reconciled), and one already split.
 *
 * Reads and prints only, unless --write. Run it from apps/api on the server
 * AFTER the API with this change is deployed (an older API editing one of these
 * payments would not know its charges line):
 *
 *   cd apps/api
 *   bun src/scripts/charges-lines-backfill.ts                       # what it would do
 *   bun src/scripts/charges-lines-backfill.ts --invoice IN-00160    # one invoice
 *   bun src/scripts/charges-lines-backfill.ts --write --expect 12   # do it, if 12 is what the dry run said
 *
 * Before writing, the lines it replaces are saved to backups/charges-lines-<time>.json beside apps/api. Safe to run
 * again: a payment already split is skipped.
 */
import fs from "node:fs";
import path from "node:path";
import mongoose from "mongoose";
import { formatMoney } from "@delta/shared";
import { Invoice } from "../modules/invoice/invoice.model";
import { BankAccount } from "../modules/banking/bank-account.model";
import { BankTransaction } from "../modules/banking/bank-transaction.model";
import { syncPaymentLine } from "../modules/invoice/payment-bank";

export interface ChargesRow {
  invoiceNumber: string;
  customerName: string;
  account: string;
  payment: string;
  charges: string;
  inAccount: string;
  skipped?: string;
  done?: boolean;
}

export async function splitChargesLines(opts: { write: boolean; invoices?: string[]; backupDir?: string }): Promise<ChargesRow[]> {
  const only = new Set((opts.invoices ?? []).map((s) => s.trim().toUpperCase()).filter(Boolean));
  const invoices = await Invoice.find({
    payments: { $elemMatch: { chargesMinor: { $gt: 0 }, bankTransactionId: { $ne: null }, bankChargesTransactionId: { $in: [null, undefined] } } },
  }).select("organizationId invoiceNumber customerName currency payments").sort({ issueDate: 1 }).lean<any[]>();
  const scoped = invoices.filter((i) => !only.size || only.has(String(i.invoiceNumber).toUpperCase()));

  const rows: ChargesRow[] = [];
  const replaced: unknown[] = [];
  const work: { invoice: any; paymentId: unknown; row: ChargesRow }[] = [];
  for (const invoice of scoped) {
    for (const p of invoice.payments ?? []) {
      if (!(Number(p.chargesMinor) > 0) || !p.bankTransactionId || p.bankChargesTransactionId) continue;
      const tx = await BankTransaction.findById(p.bankTransactionId).lean<any>();
      const account = tx ? await BankAccount.findById(tx.accountId).select("accountName accountType").lean<any>() : null;
      const row: ChargesRow = {
        invoiceNumber: invoice.invoiceNumber,
        customerName: invoice.customerName ?? "",
        account: account?.accountName ?? tx?.accountName ?? "—",
        payment: formatMoney(p.amountMinor, invoice.currency ?? "AED"),
        charges: formatMoney(p.chargesMinor, invoice.currency ?? "AED"),
        inAccount: tx ? formatMoney(tx.amountMinor, tx.currency ?? invoice.currency ?? "AED") : "—",
      };
      if (!tx) row.skipped = "its line is not there any more";
      else if (tx.isReconciled && account?.accountType !== "petty_cash") row.skipped = "reconciled against a bank statement";
      rows.push(row);
      if (!row.skipped) {
        work.push({ invoice, paymentId: p._id, row });
        replaced.push(tx);
      }
    }
  }

  if (opts.write && work.length) {
    // The lines being replaced, read back whole before anything changes.
    const dir = opts.backupDir ?? path.resolve(process.cwd(), "backups");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `charges-lines-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), lines: replaced }, null, 2));
    const back = JSON.parse(fs.readFileSync(file, "utf8")) as { lines: unknown[] };
    if (back.lines.length !== replaced.length) throw new Error(`The backup ${file} did not read back whole — nothing written`);
    console.log(`Backup of the ${replaced.length} line(s) replaced: ${file}`);
    for (const w of work) {
      await syncPaymentLine(w.invoice, w.paymentId);
      const now = await Invoice.findById(w.invoice._id).select("payments").lean<any>();
      const p = (now?.payments ?? []).find((x: any) => String(x._id) === String(w.paymentId));
      w.row.done = !!p?.bankChargesTransactionId && !!p?.bankTransactionId;
    }
  }
  return rows;
}

if (import.meta.main) {
  const write = process.argv.includes("--write");
  const invoices = process.argv.reduce<string[]>((acc, a, i) => (a === "--invoice" && process.argv[i + 1] ? [...acc, process.argv[i + 1]!] : acc), []);
  const expectAt = process.argv.indexOf("--expect");
  const expect = expectAt > -1 ? Number(process.argv[expectAt + 1]) : null;
  const { connectDb } = await import("../config/db");
  await connectDb();
  if (write) {
    const dry = await splitChargesLines({ write: false, invoices });
    const todo = dry.filter((r) => !r.skipped).length;
    if (expect === null || expect !== todo) {
      console.error(`Refusing to write: ${todo} payment(s) would be split, and --expect ${expect ?? "(missing)"} was given. Run the dry run and pass --expect ${todo}.`);
      await mongoose.disconnect();
      process.exit(1);
    }
  }
  const rows = await splitChargesLines({ write, invoices });
  for (const r of rows) {
    const what = r.skipped ? `skipped — ${r.skipped}` : write ? (r.done ? "split" : "NOT split — see the payment's note") : "would be split";
    console.log(`${r.invoiceNumber.padEnd(12)} ${r.customerName.slice(0, 24).padEnd(24)} ${r.account.slice(0, 18).padEnd(18)} payment ${r.payment.padStart(14)}  charges ${r.charges.padStart(12)}  line now ${r.inAccount.padStart(14)}  ${what}`);
  }
  const todo = rows.filter((r) => !r.skipped).length;
  console.log(`\n${todo} payment(s) ${write ? "split into a full credit and a charges debit" : "would be split"}; ${rows.length - todo} skipped.${write ? "" : ` Nothing written. Run again with --write --expect ${todo} to do it.`}`);
  await mongoose.disconnect();
}
