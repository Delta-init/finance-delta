/**
 * Enrolments approved before the LMS link was switched on.
 *
 * Provisioning is queued at the moment of approval and nowhere else. Anything
 * approved while LMS_API_URL and LMS_S2S_SECRET were unset was never queued —
 * and turning the integration on does not go back for it. Those enrolments sit
 * approved for ever with no student behind them, and nothing anywhere says so.
 *
 * This reports them, and with --apply queues them. Queueing is idempotent: an
 * invoice that already has a provisioning row is skipped, so a second run after
 * a partial one finishes the job rather than doubling it.
 *
 * READ THIS BEFORE --apply. The LMS emails an invitation to each student the
 * first time it provisions them. A backlog queued here is a backlog of
 * invitations, sent at once, some of them for enrolments months old. That is
 * not undoable. Run it without --apply first, read the count, and use --since
 * to cut it down to the enrolments you actually want a student created for.
 *
 * Run with:
 *   bun apps/api/src/scripts/backfill-lms-provisions.ts
 *   bun apps/api/src/scripts/backfill-lms-provisions.ts --since 2026-09-01
 *   bun apps/api/src/scripts/backfill-lms-provisions.ts --since 2026-09-01 --apply
 */

import mongoose from "mongoose";
import { connectDb } from "../config/db";
import { Invoice } from "../modules/invoice/invoice.model";
import { LmsProvision } from "../modules/integrations/lms-provision.model";
import { queueLmsProvision } from "../modules/invoice/invoice.service";
import { lmsConfigured } from "../lib/lms-client";

const APPLY = process.argv.includes("--apply");
const sinceArg = process.argv[process.argv.indexOf("--since") + 1];
const SINCE = process.argv.includes("--since") && sinceArg ? new Date(sinceArg) : null;

async function run() {
  if (SINCE && Number.isNaN(SINCE.getTime())) {
    console.error(`--since "${sinceArg}" is not a date. Use YYYY-MM-DD.`);
    process.exit(1);
  }

  await connectDb();

  /*
   * Said before anything else, because it is the likeliest reason somebody is
   * running this at all — and queueing against an unconfigured LMS just builds
   * a pile of rows that go nowhere.
   */
  console.log(`LMS integration: ${lmsConfigured() ? "configured" : "NOT CONFIGURED — set LMS_API_URL and LMS_S2S_SECRET first"}`);

  const query: Record<string, unknown> = {
    "external.source": "crm",
    "approval.state": "approved",
    "enrolment.course": { $exists: true, $ne: "" },
  };
  if (SINCE) query["approval.at"] = { $gte: SINCE };

  const approved = await Invoice.find(query)
    .select("_id organizationId invoiceNumber customerName approval external enrolment lineItems customerId totalMinor")
    .sort({ "approval.at": 1 })
    .lean();

  const already = new Set(
    (await LmsProvision.find({ invoiceId: { $in: approved.map((i) => i._id) } }).select("invoiceId").lean())
      .map((r) => String(r.invoiceId)),
  );
  const missing = approved.filter((i) => !already.has(String(i._id)));

  console.log(`\napproved CRM enrolments${SINCE ? ` approved on or after ${sinceArg}` : ""}: ${approved.length}`);
  console.log(`  already have a provisioning row: ${approved.length - missing.length}`);
  console.log(`  never queued:                    ${missing.length}`);

  if (missing.length === 0) {
    console.log("\nNothing to do.");
    await mongoose.disconnect();
    return;
  }

  console.log("\nNever queued:");
  for (const i of missing.slice(0, 40)) {
    const at = (i as { approval?: { at?: Date } }).approval?.at;
    console.log(
      `  ${String(i.invoiceNumber).padEnd(12)} ${String(i.customerName ?? "").slice(0, 28).padEnd(30)}` +
        ` approved ${at ? new Date(at).toISOString().slice(0, 10) : "unknown"}`,
    );
  }
  if (missing.length > 40) console.log(`  … and ${missing.length - 40} more`);

  if (!APPLY) {
    console.log(
      `\nNothing was changed. --apply would queue ${missing.length}, and the LMS` +
        ` emails an invitation to each student it creates.`,
    );
    await mongoose.disconnect();
    return;
  }

  let queued = 0;
  for (const i of missing) {
    const doc = await Invoice.findById(i._id);
    if (!doc) continue;
    // The same function approval itself calls, so a backfilled enrolment goes
    // through exactly the checks a fresh one does — including landing as
    // "unmapped" rather than being sent on a guessed course.
    await queueLmsProvision(String(doc.organizationId), doc as never);
    queued++;
  }

  const states = await LmsProvision.aggregate([
    { $match: { invoiceId: { $in: missing.map((i) => i._id) } } },
    { $group: { _id: "$status", n: { $sum: 1 } } },
  ]);
  console.log(`\nqueued ${queued}. They now stand at:`);
  for (const s of states) console.log(`  ${String(s._id).padEnd(10)} ${s.n}`);
  console.log("\nThe provisioning worker sends the pending ones. 'unmapped' needs a course mapping, not a retry.");

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
