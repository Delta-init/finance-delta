/**
 * Statement dates for lines reconciled before statement dates existed (2026-10-23). Since then a reconciliation
 * writes each line's statement date when it is completed (banking.service.ts writeStatementDates) — its own date
 * unless another was given — and the expense it pays shows it. A line reconciled earlier has none, so its expense
 * says "Pending" for good; this gives those lines (in bank accounts — not petty cash, whose counts reconcile without a
 * statement) their own date, as completing the reconciliation would have, and their expenses the same.
 *
 * Reads and prints only, unless --write. Run it from apps/api:
 *
 *   bun --env-file=<finance .env> src/scripts/statement-dates-backfill.ts               # how many, every organization
 *   … --write --expect N                                                            # write them, N as counted
 *   … --org <organization id>                                                       # one organization only
 *
 * Undo: the lines and expenses it wrote are those with statementDate set and a reconciledSessionId from before the
 * run; there is no other source of the field, so unsetting it on them puts things back.
 */
import mongoose, { Types } from "mongoose";
import { BankAccount } from "../modules/banking/bank-account.model";
import { BankTransaction } from "../modules/banking/bank-transaction.model";
import { Expense } from "../modules/expense/expense.model";

const dayOf = (d: Date) => new Date(`${new Date(d).toISOString().slice(0, 10)}T00:00:00.000Z`);

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const arg = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const write = argv.includes("--write");
  const { connectDb } = await import("../config/db");
  await connectDb();

  const orgId = arg("--org");
  const accounts = await BankAccount.find({ ...(orgId ? { organizationId: new Types.ObjectId(orgId) } : {}), accountType: { $in: ["current", "savings"] } })
    .select("_id accountName").lean<Array<{ _id: Types.ObjectId; accountName: string }>>();
  const lines = await BankTransaction.find({ accountId: { $in: accounts.map((a) => a._id) }, isReconciled: true, statementDate: null })
    .select("_id accountId date").lean<Array<{ _id: Types.ObjectId; accountId: Types.ObjectId; date: Date }>>();
  const expenses = lines.length ? await Expense.countDocuments({ bankTransactionId: { $in: lines.map((l) => l._id) }, statementDate: null }) : 0;
  const name = new Map(accounts.map((a) => [String(a._id), a.accountName]));
  const per = new Map<string, number>();
  for (const l of lines) per.set(name.get(String(l.accountId)) ?? "?", (per.get(name.get(String(l.accountId)) ?? "?") ?? 0) + 1);
  console.table([...per].map(([Account, Lines]) => ({ Account, Lines })));
  console.log(`\n${lines.length} reconciled bank lines without a statement date (${expenses} expenses on them).`);
  if (!lines.length) console.log("Nothing to write.");
  else if (!write) console.log(`Nothing written — run again with --write --expect ${lines.length}.`);
  else if (Number(arg("--expect")) !== lines.length) {
    console.error(`Refusing: ${lines.length} to write, and --expect ${arg("--expect") ?? "(missing)"} was given.`);
    await mongoose.disconnect();
    process.exit(1);
  } else {
    await BankTransaction.bulkWrite(lines.map((l) => ({ updateOne: { filter: { _id: l._id, statementDate: null }, update: { $set: { statementDate: dayOf(l.date) } } } })));
    const r = await Expense.bulkWrite(lines.map((l) => ({ updateMany: { filter: { bankTransactionId: l._id, statementDate: null }, update: { $set: { statementDate: dayOf(l.date) } } } })));
    console.log(`\n${lines.length} lines and ${r.modifiedCount} expenses given their statement date.`);
  }
  await mongoose.disconnect();
}
