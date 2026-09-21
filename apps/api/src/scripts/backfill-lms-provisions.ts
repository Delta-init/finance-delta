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
 * Run it from apps/api, not from the repository root. Nothing here loads a
 * .env by hand — Bun reads the one in the current directory, and the only
 * directory with the API's settings in it is apps/api. Run from the root and
 * every variable is missing, which the schema reports as "JWT_ACCESS_SECRET:
 * Required" and looks nothing like the working-directory mistake it is.
 *
 *   cd apps/api
 *   bun run backfill:lms
 *   bun run backfill:lms --since 2026-09-01 --apply
 *   bun run backfill:lms --requeue-unmapped --apply
 */

import mongoose from "mongoose";
import { connectDb } from "../config/db";
import { Invoice } from "../modules/invoice/invoice.model";
import { LmsProvision } from "../modules/integrations/lms-provision.model";
import { queueLmsProvision } from "../modules/invoice/invoice.service";
import { lmsConfigured } from "../lib/lms-client";

const APPLY = process.argv.includes("--apply");
/* Clear the unmapped rows and queue them afresh. For after somebody has mapped
   the catalogue item: nothing else ever will, because queueing happens at
   approval and these invoices were approved long ago. */
const REQUEUE = process.argv.includes("--requeue-unmapped");
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

  /*
   * What became of the rows that do exist.
   *
   * "Queued" is not "provisioned". A row can sit unmapped for want of a course
   * slug, or fail permanently because the LMS refused it, and both look
   * identical from the enrolment: approved, no student. Without this the script
   * answers the smaller half of the question and leaves somebody believing the
   * integration is broken when it is one missing mapping.
   */
  const existing = await LmsProvision.find({ invoiceId: { $in: approved.map((i) => i._id) } })
    .select("invoiceId invoiceNumber status lastError attempts")
    .lean();

  if (existing.length > 0) {
    const byStatus = new Map<string, number>();
    for (const r of existing) byStatus.set(String(r.status), (byStatus.get(String(r.status)) ?? 0) + 1);
    console.log("\nthe rows that exist stand at:");
    for (const [state, n] of byStatus) console.log(`  ${state.padEnd(10)} ${n}`);

    const stuck = existing.filter((r) => r.status === "unmapped" || r.status === "failed");
    if (stuck.length > 0) {
      const { Item } = await import("../modules/inventory/item.model");
      const byInvoice = new Map(approved.map((i) => [String(i._id), i]));

      console.log("\nnot going anywhere on their own:");
      for (const r of stuck) {
        /*
         * Naming the item, not just the invoice.
         *
         * "No LMS course is mapped to the item on this invoice" is true and
         * unhelpful: it does not say which item, and that is the one thing
         * somebody needs in order to go and fix it.
         */
        const inv = byInvoice.get(String(r.invoiceId));
        const lines = ((inv as { lineItems?: { itemId?: string; description?: string }[] } | undefined)?.lineItems) ?? [];
        const names: string[] = [];
        for (const line of lines) {
          if (!line.itemId) { names.push(`${line.description ?? "a line"} — not a catalogue item at all`); continue; }
          const item = await Item.findById(line.itemId).select("name sku lmsCourseSlug").lean<{ name?: string; sku?: string; lmsCourseSlug?: string } | null>();
          names.push(item ? `${item.name ?? "(unnamed)"}${item.sku ? ` [${item.sku}]` : ""}` : "an item that no longer exists");
        }
        console.log(`  ${String(r.invoiceNumber).padEnd(12)} ${String(r.status).padEnd(9)} ${r.lastError ?? ""}`);
        for (const n of names) console.log(`               item: ${n}`);
      }
      console.log(
        "\n  unmapped = that item has no LMS course slug. Set it on the item —" +
          "\n             Inventory, the item, \"LMS course\" — then run this again" +
          "\n             with --requeue-unmapped --apply. Mapping alone changes" +
          "\n             nothing: queueing happens at approval, and these were" +
          "\n             approved long ago." +
          "\n  failed   = the LMS refused it. The reason is above.",
      );
    }

    if (REQUEUE) {
      const unmapped = existing.filter((r) => r.status === "unmapped");
      if (unmapped.length === 0) {
        console.log("\nNo unmapped rows to requeue.");
      } else if (!APPLY) {
        console.log(`\n--requeue-unmapped would clear and requeue ${unmapped.length}. Add --apply to do it.`);
      } else {
        await LmsProvision.deleteMany({ _id: { $in: unmapped.map((r) => r._id) } });
        let again = 0;
        for (const r of unmapped) {
          const doc = await Invoice.findById(r.invoiceId);
          if (!doc) continue;
          await queueLmsProvision(String(doc.organizationId), doc as never);
          again++;
        }
        const after = await LmsProvision.aggregate([
          { $match: { invoiceId: { $in: unmapped.map((r) => r.invoiceId) } } },
          { $group: { _id: "$status", n: { $sum: 1 } } },
        ]);
        console.log(`\nrequeued ${again}. They now stand at:`);
        for (const a of after) console.log(`  ${String(a._id).padEnd(10)} ${a.n}`);
        console.log("  (still 'unmapped' means the item's LMS course is still not set)");
      }
    }
  }

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
