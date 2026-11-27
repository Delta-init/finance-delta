/**
 * Payroll counts in the month the pay is for (the user, 2026-11-27: October's salaries, paid early in November, are
 * October's expense). New payroll payments post their expense dated on the last day of the payroll month
 * (payroll/posting.service.ts); this re-dates the ones posted before, which carry the day they were paid.
 *
 * For every payroll expense (source.kind "payroll", key "payroll:<run id>:<payment id>"): its run's month gives the date
 * it should have. Only `expenseDate` changes — the day paid (`paidOn`), the amount, the bank line and everything else
 * stay as they are. Nobody is emailed.
 *
 * Reads and prints only, unless --write; --write saves an undo file first and adds to it as it goes. Run it from
 * apps/api on the server:
 *
 *   bun src/scripts/payroll-expense-dates.ts                           # what it would do
 *   bun src/scripts/payroll-expense-dates.ts --write --expect <code>   # <code> as the look printed it
 *   bun src/scripts/payroll-expense-dates.ts --undo <file>
 */
import mongoose from "mongoose";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { formatMoney } from "@delta/shared";

export interface PayrollDateRow {
  id: string; expense: string; run: string; period: string; currency: string; amountMinor: number;
  /** As stored now, ISO; empty when none. */
  before: string;
  after: string;
}

const EJSON = () => mongoose.mongo.BSON.EJSON;

/** Every payroll expense whose date is not the last day of its payroll month. */
export async function findPayrollDates(): Promise<{ rows: PayrollDateRow[]; orphans: string[] }> {
  const { Expense } = await import("../modules/expense/expense.model");
  const { PayrollRun } = await import("../modules/payroll/payroll-run.model");
  const { payrollMonthEnd } = await import("../modules/payroll/posting.service");
  const expenses = await Expense.collection.find({ "source.kind": "payroll" })
    .project({ expenseNumber: 1, expenseDate: 1, totalMinor: 1, currency: 1, "source.key": 1 }).sort({ expenseDate: 1 }).toArray();
  const runIds = [...new Set(expenses.map((e: any) => String(e.source?.key ?? "").split(":")[1] ?? "").filter((id) => id && mongoose.Types.ObjectId.isValid(id)))];
  const runs = new Map((await PayrollRun.collection.find({ _id: { $in: runIds.map((id) => new mongoose.Types.ObjectId(id)) } }).project({ period: 1, runNumber: 1 }).toArray())
    .map((r: any) => [String(r._id), r]));
  const rows: PayrollDateRow[] = [];
  const orphans: string[] = [];
  for (const e of expenses as any[]) {
    const run = runs.get(String(e.source?.key ?? "").split(":")[1] ?? "");
    if (!run?.period) { orphans.push(String(e.expenseNumber)); continue; }
    const after = payrollMonthEnd(run.period);
    const before = e.expenseDate ? new Date(e.expenseDate) : null;
    if (before && before.getTime() === after.getTime()) continue;
    rows.push({
      id: String(e._id), expense: String(e.expenseNumber), run: String(run.runNumber ?? ""), period: run.period,
      currency: String(e.currency ?? "AED"), amountMinor: Number(e.totalMinor) || 0,
      before: before ? before.toISOString() : "", after: after.toISOString(),
    });
  }
  return { rows, orphans };
}

const codeOf = (rows: PayrollDateRow[]) => createHash("sha256").update(rows.map((r) => `${r.id}:${r.before}>${r.after}`).join("|")).digest("hex").slice(0, 8);

export async function redatePayrollExpenses(o: { write: boolean; expect?: string; undoFile?: string }) {
  const { rows, orphans } = await findPayrollDates();
  const code = codeOf(rows);
  if (!o.write || !rows.length) return { rows, orphans, code, written: 0 };
  if (o.expect !== code) throw new Error(`--expect ${o.expect ?? "(none)"} is not what there is now (${code}) — look again before writing`);
  const { Expense } = await import("../modules/expense/expense.model");
  const undoFile = o.undoFile ?? `payroll-expense-dates-undo-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const done: PayrollDateRow[] = [];
  const save = () => writeFileSync(undoFile, EJSON().stringify({ expenses: done }, undefined, 2, { relaxed: false }));
  save();
  for (const r of rows) {
    // Only if it still has the date it was looked at with.
    const res = await Expense.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(r.id), "source.kind": "payroll", expenseDate: r.before ? new Date(r.before) : { $in: [null] } },
      { $set: { expenseDate: new Date(r.after) } },
    );
    if (!res.matchedCount) throw new Error(`Expense ${r.expense} changed while this ran — nothing more was written; ${done.length} done so far are in ${undoFile}`);
    done.push(r);
    save();
  }
  return { rows, orphans, code, written: done.length, undoFile };
}

/** Puts back each date a --write changed, from its undo file — only where the date is still the one written. */
export async function undoPayrollDates(file: string): Promise<{ restored: number; skipped: string[] }> {
  const { Expense } = await import("../modules/expense/expense.model");
  const { expenses } = EJSON().parse(readFileSync(file, "utf8"), { relaxed: false }) as { expenses: PayrollDateRow[] };
  let restored = 0;
  const skipped: string[] = [];
  for (const r of [...expenses].reverse()) {
    const res = await Expense.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(r.id), expenseDate: new Date(r.after) },
      r.before ? { $set: { expenseDate: new Date(r.before) } } : { $unset: { expenseDate: "" } },
    );
    if (res.matchedCount) restored++; else skipped.push(r.expense);
  }
  return { restored, skipped };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const arg = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const { connectDb } = await import("../config/db");
  await connectDb();
  try {
    const undo = arg("--undo");
    if (undo) {
      const { restored, skipped } = await undoPayrollDates(undo);
      console.log(`${restored} expense(s) put back as they were, from ${undo}${skipped.length ? `; left alone (changed since): ${skipped.join(", ")}` : ""}`);
    } else {
      const write = args.includes("--write");
      const { rows, orphans, code, written, undoFile } = await redatePayrollExpenses({ write, expect: arg("--expect") });
      for (const r of rows) {
        console.log(`${r.expense.padEnd(10)} ${r.run.padEnd(12)} payroll ${r.period}  ${formatMoney(r.amountMinor, r.currency).padStart(16)}  ${r.before ? r.before.slice(0, 10) : "no date"} → ${r.after.slice(0, 10)}`);
      }
      if (orphans.length) console.log(`\nLeft alone, their payroll run not found: ${orphans.join(", ")}`);
      console.log(`\n${rows.length} payroll expense(s) dated by the day paid: ${write ? `${written} re-dated` : "would be re-dated"} to the last day of their payroll month. Only the expense date; the day paid, the amount and the bank are not touched. Nobody is emailed.`);
      if (!write && rows.length) console.log(`To write:  bun src/scripts/payroll-expense-dates.ts --write --expect ${code}`);
      if (undoFile) console.log(`Undo file: ${undoFile}  (bun src/scripts/payroll-expense-dates.ts --undo ${undoFile})`);
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}
