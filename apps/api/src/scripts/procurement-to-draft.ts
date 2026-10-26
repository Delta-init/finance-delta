/**
 * Purchase requests finance approved before 2026-10-26 and nobody has paid, made drafts — as an approval makes them now
 * (the user: "first approve time the expense will be marked as draft, then after it is paid it will be updated, with
 * the receipt, as paid"). Each then waits for "Record payment" with its receipt, like a new one. The paid ones, and
 * any with a bank line, are left as they are.
 *
 * Reads and prints only, unless --write. Run it from apps/api:
 *
 *   bun --env-file=<finance .env> src/scripts/procurement-to-draft.ts
 *   … --write --expect N --backups <folder>       N: how many expenses become drafts
 *   bun --env-file=<finance .env> src/scripts/procurement-to-draft.ts --undo <backup.json> [--write]
 */
import fs from "node:fs";
import path from "node:path";
import mongoose, { Types } from "mongoose";
import { Expense } from "../modules/expense/expense.model";

/** Approved, unpaid, not in Banking: what waits for its payment from now. */
const WAITING = { "source.kind": "hrms_procurement", status: "approved", paidOn: null, bankTransactionId: null };

export interface PlannedExpense { id: string; orgId: string; expenseNumber: string; description: string; totalMinor: number; currency: string; approvedAt: string | null }

export async function planProcurementDrafts(): Promise<PlannedExpense[]> {
  const rows = await Expense.find(WAITING).select("organizationId expenseNumber description totalMinor currency approvedAt").sort({ expenseNumber: 1 })
    .lean<{ _id: Types.ObjectId; organizationId: Types.ObjectId; expenseNumber: string; description?: string; totalMinor?: number; currency?: string; approvedAt?: Date }[]>();
  return rows.map((r) => ({
    id: String(r._id), orgId: String(r.organizationId), expenseNumber: r.expenseNumber, description: r.description ?? "",
    totalMinor: r.totalMinor ?? 0, currency: r.currency ?? "AED", approvedAt: r.approvedAt ? r.approvedAt.toISOString().slice(0, 10) : null,
  }));
}

/** Makes them drafts, keeping a backup (written first) that --undo takes back. Each is checked again as it is changed. */
export async function runProcurementDrafts(backupDir = "backups"): Promise<{ changed: PlannedExpense[]; file: string }> {
  const todo = await planProcurementDrafts();
  const dir = path.resolve(backupDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `procurement-to-draft-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify({ changed: todo }, null, 1));
  const changed: PlannedExpense[] = [];
  for (const p of todo) {
    const r = await Expense.updateOne({ _id: new Types.ObjectId(p.id), ...WAITING }, { $set: { status: "draft" } });
    if (r.modifiedCount === 1) changed.push(p);
  }
  fs.writeFileSync(file, JSON.stringify({ changed }, null, 1));
  return { changed, file };
}

/** Back to approved — only those still drafts and unpaid (one paid since keeps its payment). */
export async function undoProcurementDrafts(file: string, write: boolean): Promise<string[]> {
  const { changed } = JSON.parse(fs.readFileSync(file, "utf8")) as { changed: PlannedExpense[] };
  const out: string[] = [];
  for (const c of changed) {
    const filter = { _id: new Types.ObjectId(c.id), "source.kind": "hrms_procurement", status: "draft", paidOn: null };
    const still = await Expense.exists(filter);
    if (!still) { out.push(`${c.expenseNumber}: left as it is (paid or changed since)`); continue; }
    if (write) await Expense.updateOne(filter, { $set: { status: "approved" } });
    out.push(`${c.expenseNumber}: ${write ? "approved again" : "would be approved again"}`);
  }
  return out;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const arg = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const write = argv.includes("--write");
  const { connectDb } = await import("../config/db");
  await connectDb();
  const undo = arg("--undo");
  if (undo) {
    for (const l of await undoProcurementDrafts(undo, write)) console.log(l);
    if (!write) console.log("\nNothing changed — run again with --write.");
    await mongoose.disconnect();
    process.exit(0);
  }
  const plan = await planProcurementDrafts();
  for (const p of plan) {
    console.log(`${p.expenseNumber}  ${p.currency} ${(p.totalMinor / 100).toFixed(2).padStart(10)}  approved ${p.approvedAt ?? "?"}  ${p.description}`);
  }
  console.log(`\n${plan.length} approved purchase request(s) not paid yet would become drafts, waiting for their payment.`);
  if (!plan.length) console.log("Nothing to change.");
  else if (!write) console.log(`Nothing changed — run again with --write --expect ${plan.length}.`);
  else if (Number(arg("--expect")) !== plan.length) {
    console.error(`Refusing: ${plan.length} to change, and --expect ${arg("--expect") ?? "(missing)"} was given.`);
    await mongoose.disconnect();
    process.exit(1);
  } else {
    const { changed, file } = await runProcurementDrafts(arg("--backups"));
    console.log(`\n${changed.length} made drafts. Backup: ${file}\nUndo: bun --env-file=<finance .env> src/scripts/procurement-to-draft.ts --undo ${file} --write`);
  }
  await mongoose.disconnect();
}
