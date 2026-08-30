/**
 * Move the approval an enrolment was carrying up onto its invoice.
 *
 * Approval used to live inside `enrolment`, which meant only an enrolment could
 * be approved. It is now a property of the invoice, so that a plain invoice
 * raised by somebody who only sees their own records is checked on the same
 * terms. This carries the existing decisions across.
 *
 * Every other invoice is left alone: reading a missing block as `not_required`
 * is exactly right for one raised under the old rules, and writing that to
 * millions of documents to say "nothing to do" would be pointless. Invoices
 * with an enrolment are the only ones that ever held a decision worth keeping.
 *
 * Idempotent — an invoice that already has an approval block is skipped, so a
 * second run after a partial one finishes the job rather than undoing it.
 *
 * Prints what it would do and changes nothing without --apply.
 *
 * Run with:  bun apps/api/src/scripts/lift-invoice-approvals.ts [--apply]
 */

import mongoose from "mongoose";
import { connectDb } from "../config/db";

const APPLY = process.argv.includes("--apply");

async function run() {
  await connectDb();
  const invoices = mongoose.connection.db!.collection("invoices");

  const candidates = await invoices
    .find({ "enrolment.approval": { $exists: true }, "approval.state": { $exists: false } })
    .toArray();

  if (candidates.length === 0) {
    console.log("Nothing to lift — no enrolment carries an approval that its invoice lacks.");
    await mongoose.disconnect();
    return;
  }

  const counts: Record<string, number> = {};
  for (const inv of candidates) {
    const e = inv.enrolment as Record<string, unknown>;
    const state = String(e.approval ?? "pending");
    counts[state] = (counts[state] ?? 0) + 1;

    if (APPLY) {
      await invoices.updateOne(
        { _id: inv._id },
        {
          $set: {
            approval: {
              state,
              byId: e.approvedById ?? undefined,
              byName: e.approvedByName ?? undefined,
              at: e.approvedAt ?? undefined,
              returnedReason: e.returnedReason ?? undefined,
              submittedAt: e.submittedAt ?? undefined,
            },
          },
          // The enrolment keeps what it is; it no longer decides what may be sent.
          $unset: {
            "enrolment.approval": "",
            "enrolment.approvedById": "",
            "enrolment.approvedByName": "",
            "enrolment.approvedAt": "",
            "enrolment.returnedReason": "",
            "enrolment.submittedAt": "",
          },
        },
      );
    }
  }

  console.log(`${candidates.length} invoice(s) to lift:`);
  for (const [state, n] of Object.entries(counts)) console.log(`  ${state}: ${n}`);
  console.log(
    APPLY
      ? "\nDone."
      : "\nDry run — nothing written. Re-run with --apply.",
  );

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
