/**
 * Expenses for the bills already in finance (2026-10-23): every bill since bills make their own expense does, and
 * this makes one for each bill from before — through syncBillExpense, as a new bill gets it. A bill with no category
 * yet goes under Other / Pending classification until someone edits the bill and picks one.
 *
 * Its expenses count in no report that already counts bills (P&L, cash flow, Daily Report, dashboard, VAT): only the
 * Expenses list and Expense by category show them.
 *
 * Reads and prints only, unless --write. Run it from apps/api:
 *
 *   bun --env-file=<finance .env> src/scripts/bill-expenses-backfill.ts            # what it would make, every organization
 *   … --write --expect N                                                          # make them, N as counted
 *   … --org <organization id>                                                     # one organization only
 *
 * Undo: delete the expenses whose source.kind is "bill" and that were made by the run (their createdAt), or void them.
 */
import mongoose, { Types } from "mongoose";
import { Bill } from "../modules/bill/bill.model";
import { Expense } from "../modules/expense/expense.model";
import { syncBillExpense } from "../modules/bill/bill-expense";

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const arg = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const write = argv.includes("--write");
  const { connectDb } = await import("../config/db");
  await connectDb();

  const orgId = arg("--org");
  const filter: Record<string, unknown> = orgId ? { organizationId: new Types.ObjectId(orgId) } : {};
  const all = await Bill.find(filter).select("organizationId billNumber vendorName billDate totalMinor currency status category").lean<any[]>();
  const have = new Set((await Expense.find({ "source.kind": "bill" }).select("source.billId").lean<any[]>()).map((e) => String(e.source?.billId)));
  const todo = all.filter((b) => !have.has(String(b._id)));
  console.table(todo.slice(0, 200).map((b) => ({
    Bill: b.billNumber, Vendor: String(b.vendorName ?? "").slice(0, 30), Date: new Date(b.billDate).toISOString().slice(0, 10),
    Total: `${b.currency ?? "AED"} ${((b.totalMinor ?? 0) / 100).toFixed(2)}`, Status: b.status, Category: b.category || "— (Pending classification)",
  })));
  if (todo.length > 200) console.log(`…and ${todo.length - 200} more`);
  console.log(`\n${all.length} bills, ${all.length - todo.length} with their expense already, ${todo.length} to make.`);
  if (!todo.length) console.log("Nothing to make.");
  else if (!write) console.log(`Nothing made — run again with --write --expect ${todo.length}.`);
  else if (Number(arg("--expect")) !== todo.length) {
    console.error(`Refusing: ${todo.length} to make, and --expect ${arg("--expect") ?? "(missing)"} was given.`);
    await mongoose.disconnect();
    process.exit(1);
  } else {
    let made = 0;
    for (const b of todo) {
      await syncBillExpense(String(b.organizationId), b._id);
      if (await Expense.exists({ "source.key": `bill:${b._id}` })) made++;
    }
    console.log(`\n${made} of ${todo.length} expenses made.`);
  }
  await mongoose.disconnect();
}
