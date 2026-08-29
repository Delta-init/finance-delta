/**
 * One-time migration: `checking` → `current` on bank accounts.
 *
 * "Checking" is US usage; every bank these accounts are actually held with
 * calls the same product a current account. The enum was renamed rather than
 * gaining a second member, because two names for one thing is how a list ends
 * up split down the middle.
 *
 * It also re-files accounts whose name says "current" but which were recorded
 * as `internal` — the type they were given because no better one existed.
 * Those are listed for confirmation before anything is written.
 *
 * Prints what it would do and changes nothing unless run with --apply.
 *
 * Run with:  bun apps/api/src/scripts/migrate-account-types.ts [--apply]
 */

import mongoose from "mongoose";
import { connectDb } from "../config/db";

const APPLY = process.argv.includes("--apply");

/** Named as a current account but filed as something else. */
const NAMED_CURRENT = /\bcurrent\b/i;

async function run() {
  await connectDb();
  const accounts = mongoose.connection.db!.collection("bankaccounts");

  const legacy = await accounts.find({ accountType: "checking" }).toArray();
  const misfiled = (await accounts.find({ accountType: "internal" }).toArray()).filter((a) =>
    NAMED_CURRENT.test(String(a.accountName ?? "")),
  );

  console.log(`\nchecking → current: ${legacy.length} account(s)`);
  for (const a of legacy) console.log(`  · ${a.accountName}  (${a.currency})`);

  console.log(`\ninternal → current: ${misfiled.length} account(s) named as current`);
  for (const a of misfiled) console.log(`  · ${a.accountName}  (${a.currency})`);

  const total = legacy.length + misfiled.length;
  if (total === 0) {
    console.log("\nNothing to migrate.");
    await mongoose.disconnect();
    return;
  }

  if (!APPLY) {
    console.log(`\nDry run — nothing written. Re-run with --apply to change ${total} account(s).`);
    await mongoose.disconnect();
    return;
  }

  // Only the ids listed above, so an account created between the read and the
  // write is not swept up by a broad filter.
  const ids = [...legacy, ...misfiled].map((a) => a._id);
  const res = await accounts.updateMany({ _id: { $in: ids } }, { $set: { accountType: "current" } });
  console.log(`\nUpdated ${res.modifiedCount} account(s).`);

  const remaining = await accounts.countDocuments({ accountType: "checking" });
  if (remaining > 0) console.warn(`WARNING: ${remaining} account(s) still typed "checking".`);

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
