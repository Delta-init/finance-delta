/**
 * Payroll payments whose money went out of the bank account twice (the user, 2026-11-05: "why the expense and payroll
 * double entries came" — PAY-202610-002 showed "Payroll PAY-202610-002 · … AED 3,500" and "EXP-00273 · Payroll
 * PAY-202610-002 · … AED 3,500" in the same account, the running balance down by both).
 *
 * A payroll payment puts its money-out line in its account, and posts an expense for the P&L. That expense was saved
 * unpaid and in no account, so in Expenses it read as unpaid — and marked paid there (or given an account) it got a
 * money-out line of its own. Since 2026-11-05 the expense is posted paid, in the payment's account, through the
 * payment's own line, and can't be marked paid again.
 *
 * This puts the ones from before right: each payroll payment's expense is linked to the payment's line, paid on its
 * day, in its account — and a line the expense made of its own is taken out, the account's balance worked out again.
 * One reconciled against a bank statement is not touched: it is listed, to be un-reconciled first.
 *
 * Reads and prints only, unless --write; --write saves an undo file first and adds to it as it goes (--undo <file>
 * puts every line it took out back, and the expenses as they were). Run it from apps/api on the server:
 *
 *   bun src/scripts/payroll-expense-lines-fix.ts                       # what it would do
 *   bun src/scripts/payroll-expense-lines-fix.ts --write --expect N    # N = the "would fix" count shown
 *   bun src/scripts/payroll-expense-lines-fix.ts --undo <file>
 */
import mongoose, { Types } from "mongoose";
import { readFileSync, writeFileSync } from "node:fs";
import { formatMoney } from "@delta/shared";

export interface Row {
  payment: string;
  expense: string;
  amount: string;
  outcome: "would fix" | "fixed" | "left";
  detail: string;
}
interface Undo {
  expenses: Array<{ id: string; organizationId: string; before: Record<string, unknown> }>;
  /** The lines taken out, whole, to be put back as they were. */
  lines: Array<Record<string, unknown>>;
}

const FIELDS = ["paidOn", "bankAccountId", "bankTransactionId", "source", "bankNote", "paymentAccount", "statementDate"] as const;

export async function fixPayrollExpenseLines(o: { write: boolean; expect?: number; undoFile?: string }): Promise<{ rows: Row[]; undoFile?: string }> {
  const { PayrollRun } = await import("../modules/payroll/payroll-run.model");
  const { Expense } = await import("../modules/expense/expense.model");
  const { BankTransaction } = await import("../modules/banking/bank-transaction.model");
  const { assertDebitMovable } = await import("../modules/banking/money-out");
  const { recalculateRunningBalances } = await import("../modules/banking/banking.service");

  const runs = await PayrollRun.find({ "payments.expenseId": { $ne: null } })
    .select("organizationId runNumber payments").sort({ period: 1 }).lean<any[]>();

  type Plan = { row: Row; orgId: string; expense: any; payment: any; runId: string; ownLine: any | null; set: Record<string, unknown> };
  const plans: Plan[] = [];
  for (const run of runs) {
    const orgId = String(run.organizationId);
    for (const p of run.payments ?? []) {
      if (!p.expenseId) continue;
      const expense = await Expense.findOne({ _id: p.expenseId, organizationId: run.organizationId }).lean<any>();
      const amount = formatMoney(p.amountMinor ?? 0, p.currency || "AED");
      if (!expense) continue;
      const theirs = [p.bankTransactionId, p.reversalTransactionId].filter(Boolean).map(String);
      const ownId = expense.bankTransactionId && !theirs.includes(String(expense.bankTransactionId)) ? expense.bankTransactionId : null;
      const ownLine = ownId ? await BankTransaction.findOne({ _id: ownId, organizationId: run.organizationId }).lean<any>() : null;

      const set: Record<string, unknown> = {};
      if (String(expense.bankTransactionId ?? "") !== String(p.bankTransactionId ?? "")) set.bankTransactionId = p.bankTransactionId ?? null;
      if (p.bankAccountId && String(expense.bankAccountId ?? "") !== String(p.bankAccountId)) {
        set.bankAccountId = p.bankAccountId;
        set.paymentAccount = p.bankAccountName ?? expense.paymentAccount ?? "";
      }
      if (!expense.paidOn || new Date(expense.paidOn).getTime() !== new Date(p.paidOn).getTime()) set.paidOn = p.paidOn;
      if (expense.source?.kind !== "payroll" && !expense.source?.key) set.source = { kind: "payroll", key: `payroll:${run._id}:${p.paymentId}`, round: 0 };
      if (expense.bankNote) set.bankNote = "";
      // A statement date it got from its own line goes with that line; the payment's line gives it one when reconciled.
      if (ownLine && expense.statementDate) set.statementDate = null;
      if (!Object.keys(set).length && !ownId) continue;

      const what = [
        ownLine ? `takes out its own line in ${ownLine.accountName} (${formatMoney(Math.abs(ownLine.amountMinor ?? 0), ownLine.currency || "AED")} on ${new Date(ownLine.date).toISOString().slice(0, 10)})` : ownId ? "its own line is gone already" : "",
        set.bankTransactionId !== undefined ? "linked to the payment's line" : "",
        set.paidOn !== undefined ? `paid ${new Date(p.paidOn).toISOString().slice(0, 10)}` : "",
      ].filter(Boolean).join("; ");
      const row: Row = { payment: String(p.paymentId), expense: String(expense.expenseNumber ?? ""), amount, outcome: "would fix", detail: what };
      if (ownLine) {
        try { await assertDebitMovable(orgId, ownLine._id); } catch (e) {
          row.outcome = "left";
          row.detail = `its own line in ${ownLine.accountName} is reconciled against a bank statement — un-reconcile it first (${(e as Error).message})`;
        }
      }
      plans.push({ row, orgId, expense, payment: p, runId: String(run._id), ownLine, set });
    }
  }

  const todo = plans.filter((x) => x.row.outcome === "would fix");
  if (!o.write) return { rows: plans.map((x) => x.row) };
  if (o.expect !== undefined && o.expect !== todo.length) {
    throw new Error(`--expect ${o.expect}, but ${todo.length} would be fixed now — run it again without --write and check`);
  }

  const undo: Undo = { expenses: [], lines: [] };
  const undoFile = o.undoFile ?? `payroll-expense-lines-fix-undo-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const save = () => {
    writeFileSync(undoFile, JSON.stringify(undo, null, 2));
    if (!Array.isArray((JSON.parse(readFileSync(undoFile, "utf8")) as Undo).expenses)) throw new Error(`The undo file ${undoFile} didn't read back — stopped`);
  };
  save();

  for (const x of todo) {
    undo.expenses.push({
      id: String(x.expense._id), organizationId: x.orgId,
      // Only what it had: a field it lacked is taken off again on undo, not left there as null.
      before: Object.fromEntries(FIELDS.filter((f) => x.expense[f] !== undefined).map((f) => [f, x.expense[f]])),
    });
    if (x.ownLine) undo.lines.push(x.ownLine);
    save();
    if (x.ownLine) {
      await BankTransaction.deleteOne({ _id: x.ownLine._id });
      await recalculateRunningBalances(x.orgId, x.ownLine.accountId);
    }
    if (Object.keys(x.set).length) await Expense.updateOne({ _id: x.expense._id }, { $set: x.set });
    x.row.outcome = "fixed";
  }
  return { rows: plans.map((x) => x.row), undoFile };
}

/** Puts the lines it took out back, and each expense as it was; the accounts' balances worked out again. */
export async function undoPayrollExpenseLines(file: string): Promise<{ expenses: number; lines: number }> {
  const { Expense } = await import("../modules/expense/expense.model");
  const { BankTransaction } = await import("../modules/banking/bank-transaction.model");
  const { recalculateRunningBalances } = await import("../modules/banking/banking.service");
  const u = JSON.parse(readFileSync(file, "utf8")) as Undo;
  // Read back as stored: these were ObjectIds and dates (a match's referenceId is a string, and stays one).
  const IDS = new Set(["_id", "organizationId", "accountId", "bankAccountId", "bankTransactionId", "id", "otherAccountId", "otherTransactionId"]);
  const revive = (v: unknown, key: string): unknown =>
    typeof v === "string" && /^[0-9a-f]{24}$/.test(v) && IDS.has(key) ? new Types.ObjectId(v)
      : typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v) ? new Date(v) : v;
  const deep = (o: unknown, key = ""): unknown =>
    Array.isArray(o) ? o.map((v) => deep(v, key)) : o && typeof o === "object" ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, deep(v, k)])) : revive(o, key);
  let lines = 0;
  for (const raw of u.lines) {
    const line = deep(raw) as Record<string, unknown>;
    if (await BankTransaction.exists({ _id: line._id })) continue;
    await BankTransaction.collection.insertOne(line as never);
    await recalculateRunningBalances(String(line.organizationId), line.accountId as Types.ObjectId);
    lines++;
  }
  let expenses = 0;
  for (const e of u.expenses) {
    const before = deep(e.before) as Record<string, unknown>;
    const $set: Record<string, unknown> = {}, $unset: Record<string, ""> = {};
    for (const f of FIELDS) {
      if (f in before) $set[f] = before[f];
      else $unset[f] = "";
    }
    const r = await Expense.collection.updateOne({ _id: new Types.ObjectId(e.id) }, { $set, ...(Object.keys($unset).length ? { $unset } : {}) });
    expenses += r.modifiedCount;
  }
  return { expenses, lines };
}

if (import.meta.main) {
  const argv = process.argv;
  const arg = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? String(argv[i + 1] ?? "") : ""; };
  const { connectDb } = await import("../config/db");
  await connectDb();
  try {
    if (arg("--undo")) {
      const r = await undoPayrollExpenseLines(arg("--undo"));
      console.log(`Put back ${r.lines} line(s) and ${r.expenses} expense(s) as they were, from ${arg("--undo")}.`);
    } else {
      const write = argv.includes("--write");
      const { rows, undoFile } = await fixPayrollExpenseLines({ write, expect: arg("--expect") ? Number(arg("--expect")) : undefined });
      for (const r of rows) console.log(`${r.payment.padEnd(20)} ${r.expense.padEnd(10)} ${r.amount.padStart(16)}  ${r.outcome.padEnd(9)} ${r.detail}`);
      const count = (x: Row["outcome"]) => rows.filter((r) => r.outcome === x).length;
      const doubled = rows.filter((r) => /takes out its own line/.test(r.detail)).length;
      console.log(`\n${rows.length} payroll expense(s) to put right — ${doubled} with the money out of the account twice: ${write ? `${count("fixed")} fixed` : `${count("would fix")} would be fixed`}, ${count("left")} left.`);
      if (undoFile) console.log(`Undo file: ${undoFile}`);
      if (!write) console.log(`Nothing written. To do it: bun src/scripts/payroll-expense-lines-fix.ts --write --expect ${count("would fix")}`);
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
  await mongoose.disconnect();
}
