/**
 * Enrolments the LMS hand-over gave up on, sent again (2026-11-26: on 24–25 Nov the Market Breakout course was renamed
 * in the LMS and put back — 13 closes of the four CRMs stopped at "LMS account" with "No course with slug
 * "market-break-out-trading-program"", and so never reached CS or onboarding).
 *
 * Lists the failed rows whose error has the words given (--match, default "No course with slug"); with --write, saves
 * an undo file first, then puts each back in the queue (pending, tried now) — the worker opens the LMS account and its
 * courses within a minute, then CS Portal, as for any new close. --expect N refuses unless exactly N match.
 * --undo <file> puts back what a run changed for rows not sent since (a student the LMS has opened stays opened).
 * Run it from apps/api on the server:
 *
 *   bun src/scripts/retry-lms-provisions.ts
 *   bun src/scripts/retry-lms-provisions.ts --expect 13 --write
 *   bun src/scripts/retry-lms-provisions.ts --undo retry-lms-provisions-undo-….json
 */
import mongoose from "mongoose";
import { readFileSync, writeFileSync } from "node:fs";

interface UndoRow { id: string; invoiceNumber: string; status: string; attempts: number; lastError: string; nextAttemptAt: string | null }

export async function failedProvisions(match: string) {
  const { LmsProvision } = await import("../modules/integrations/lms-provision.model");
  const esc = match.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (LmsProvision as mongoose.Model<any>).find({ status: "failed", lastError: { $regex: esc, $options: "i" } })
    .select("invoiceNumber status attempts lastError nextAttemptAt createdAt payload.courseSlug source")
    .sort({ createdAt: 1 }).lean<any[]>();
}

export async function retryProvisions(opts: { match: string; write: boolean; expect?: number; undoFile?: string }): Promise<{ lines: string[]; undoFile?: string }> {
  const { LmsProvision } = await import("../modules/integrations/lms-provision.model");
  const rows = await failedProvisions(opts.match);
  const lines = rows.map((r) => `${r.invoiceNumber} · ${String(r.payload?.courseSlug ?? "")} · failed after ${r.attempts ?? 0} · since ${new Date(r.createdAt).toISOString().slice(0, 16)} · ${String(r.lastError ?? "").slice(0, 80)}`);
  lines.push(`${rows.length} failed with "${opts.match}"`);
  if (opts.expect !== undefined && opts.expect !== rows.length) throw new Error(`Expected ${opts.expect}, found ${rows.length} — nothing changed`);
  if (!opts.write || !rows.length) return { lines };

  const undo: UndoRow[] = rows.map((r) => ({
    id: String(r._id), invoiceNumber: r.invoiceNumber, status: r.status, attempts: r.attempts ?? 0, lastError: String(r.lastError ?? ""),
    nextAttemptAt: r.nextAttemptAt ? new Date(r.nextAttemptAt).toISOString() : null,
  }));
  const undoFile = opts.undoFile ?? `retry-lms-provisions-undo-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(undoFile, JSON.stringify(undo, null, 2));
  if ((JSON.parse(readFileSync(undoFile, "utf8")) as UndoRow[]).length !== undo.length) throw new Error(`The undo file ${undoFile} didn't read back — nothing changed`);

  const r = await (LmsProvision as mongoose.Model<any>).updateMany(
    { _id: { $in: rows.map((x) => x._id) }, status: "failed" },
    { $set: { status: "pending", attempts: 0, nextAttemptAt: new Date() }, $unset: { lastError: 1 } },
  );
  lines.push(`${r.modifiedCount} put back in the queue — the worker sends them within a minute`);
  return { lines, undoFile };
}

export async function undoRetry(file: string): Promise<string[]> {
  const { LmsProvision } = await import("../modules/integrations/lms-provision.model");
  const rows = JSON.parse(readFileSync(file, "utf8")) as UndoRow[];
  const out: string[] = [];
  for (const u of rows) {
    // Only a row still waiting: one the LMS has taken since stays sent.
    const r = await (LmsProvision as mongoose.Model<any>).updateOne(
      { _id: u.id, status: "pending" },
      { $set: { status: u.status, attempts: u.attempts, lastError: u.lastError, nextAttemptAt: u.nextAttemptAt ? new Date(u.nextAttemptAt) : null } },
    );
    out.push(`${u.invoiceNumber}: ${r.modifiedCount ? "put back as it was" : "sent or changed since — left"}`);
  }
  return out;
}

if (import.meta.main) {
  const argv = process.argv;
  const arg = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? String(argv[i + 1] ?? "") : ""; };
  const { connectDb } = await import("../config/db");
  await connectDb();
  try {
    if (arg("--undo")) {
      for (const l of await undoRetry(arg("--undo"))) console.log(l);
    } else {
      const write = argv.includes("--write");
      const r = await retryProvisions({ match: arg("--match") || "No course with slug", write, expect: arg("--expect") ? Number(arg("--expect")) : undefined });
      for (const l of r.lines) console.log(l);
      if (r.undoFile) console.log(`\nUndo file: ${r.undoFile}`);
      if (!write) console.log("\nNothing written. Check it, then run it again with --expect <the count above> --write.");
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
  await mongoose.disconnect();
}
