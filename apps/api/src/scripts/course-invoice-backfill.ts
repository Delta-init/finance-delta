/**
 * Course payments approved before they became invoices (the user, 2026-10-12).
 *
 * Since 2026-10-12 an approved course payment from Tetra Commission — a course
 * upgrade's payment, or a bonus's course payment — is recorded on an invoice
 * with a receipt (modules/tetra-deposit/course-invoice.ts). This does the same
 * for the ones approved before: each goes on the student's open invoice for the
 * course, or on a new one, gets its receipt number, and the decision is sent to
 * Tetra Commission again so it shows the invoice (it answers a repeat as
 * "already", changing nothing else).
 *
 * One that might be invoiced by hand already — the client has an invoice typed
 * here since the payment was raised — is listed and left alone, unless named
 * with --include. --skip leaves the named ones out (a test student's, say) —
 * a request id or a student code. Clients are not emailed their receipt unless --email.
 *
 * Reads and prints only, unless --write. Run it from apps/api on the server
 * (Bun reads MONGODB_URI from the .env there):
 *
 *   bun src/scripts/course-invoice-backfill.ts                       # what it would do
 *   bun src/scripts/course-invoice-backfill.ts --write               # do it
 *   bun src/scripts/course-invoice-backfill.ts --write --skip STU-2876,STU-4267
 *   bun src/scripts/course-invoice-backfill.ts --write --include <request id>[,<id>…] --email
 */
import mongoose from "mongoose";
import { formatMoney } from "@delta/shared";
import { TetraDepositModel } from "../modules/tetra-deposit/tetra-deposit.model";
import { isCoursePayment, planCoursePayment, recordCoursePayment } from "../modules/tetra-deposit/course-invoice";

export interface BackfillRow {
  id: string;
  type: string;
  student: string;
  course: string;
  amount: string;
  onto: string;
  outcome: string;
}

export async function backfillCourseInvoices(opts: { write: boolean; include?: string[]; skip?: string[]; email?: boolean }): Promise<BackfillRow[]> {
  const include = new Set(opts.include ?? []);
  const skip = new Set((opts.skip ?? []).map((s) => s.trim().toUpperCase()));
  const rows = await TetraDepositModel.find({
    status: "approved",
    type: { $in: ["COURSE_UPGRADE", "BONUS"] },
    "courseInvoice.receiptNumber": { $in: [null, ""] },
  }).sort({ requestedAt: 1 }).lean<any[]>();
  const out: BackfillRow[] = [];
  for (const row of rows) {
    if (!isCoursePayment(row)) continue;
    const plan = await planCoursePayment(row);
    const base = {
      id: String(row._id),
      type: row.type === "COURSE_UPGRADE" ? "upgrade" : "bonus",
      student: [row.student?.code, row.student?.name].filter(Boolean).join(" "),
      course: String(row.coursePayment?.product ?? ""),
      amount: formatMoney(plan.amountMinor, "AED"),
      onto: plan.onto ? `on ${plan.onto}` : `new invoice of ${formatMoney(plan.totalMinor, "AED")}`,
    };
    if (skip.has(String(row._id).toUpperCase()) || skip.has(String(row.student?.code ?? "").toUpperCase())) { out.push({ ...base, outcome: "skipped (--skip)" }); continue; }
    if (plan.refusal) { out.push({ ...base, outcome: `not possible: ${plan.refusal}` }); continue; }
    if (plan.handTyped.length && !include.has(String(row._id))) {
      out.push({ ...base, outcome: `left alone — typed by hand since: ${plan.handTyped.join(", ")} (--include ${row._id} to do it)` });
      continue;
    }
    if (!opts.write) { out.push({ ...base, outcome: "would be recorded" }); continue; }
    const done = await recordCoursePayment(row, { email: opts.email === true });
    if (!done.ok) { out.push({ ...base, outcome: `not recorded: ${done.message}` }); continue; }
    const after = await TetraDepositModel.findById(row._id).lean<any>();
    // Sent again by the worker, now carrying the invoice.
    await TetraDepositModel.updateOne({ _id: row._id }, {
      $set: { "delivery.state": "queued", "delivery.attempts": 0, "delivery.nextAttemptAt": new Date() },
      $unset: { "delivery.claimedAt": "", "delivery.lastError": "" },
    });
    out.push({ ...base, onto: `${after?.courseInvoice?.created ? "made" : "on"} ${after?.courseInvoice?.invoiceNumber}`, outcome: `recorded, receipt ${after?.courseInvoice?.receiptNumber}` });
  }
  return out;
}

if (import.meta.main) {
  const write = process.argv.includes("--write");
  const email = process.argv.includes("--email");
  const i = process.argv.indexOf("--include");
  const include = i >= 0 ? String(process.argv[i + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean) : [];
  const k = process.argv.indexOf("--skip");
  const skip = k >= 0 ? String(process.argv[k + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean) : [];
  const { connectDb } = await import("../config/db");
  await connectDb();
  const rows = await backfillCourseInvoices({ write, include, skip, email });
  for (const r of rows) {
    console.log(`${r.type.padEnd(8)} ${r.student.slice(0, 30).padEnd(30)} ${r.course.padEnd(11)} ${r.amount.padEnd(14)} ${r.onto.padEnd(28)} ${r.outcome}`);
  }
  const recorded = rows.filter((r) => r.outcome.startsWith("recorded") || r.outcome === "would be recorded").length;
  console.log(`\n${rows.length} approved course payment(s) without an invoice; ${recorded} ${write ? "recorded" : "would be recorded"}${write ? (email ? ", clients emailed" : ", clients not emailed (--email to)") : " — nothing written. Run again with --write to do it."}`);
  await mongoose.disconnect();
}
