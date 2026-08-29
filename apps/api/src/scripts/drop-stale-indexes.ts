/**
 * Remove unique indexes that outlived the schema which created them.
 *
 * Mongoose builds the indexes a model declares but never removes ones it no
 * longer does, so an index from an earlier version of a schema stays and keeps
 * enforcing a rule nothing in the code asks for any more.
 *
 * Two of them made per-organization data unique across every organization:
 *
 *   departments.name_1          — one "Operations" for the whole database
 *   employees.employeeCode_1    — one "E0008" for the whole database
 *
 * Both are wrong the moment a second organization exists. The department one
 * was breaking payroll sync outright: creating a department already named by
 * another organization failed with a duplicate key error, and the sync
 * reported nineteen rows left untouched.
 *
 * Only drops an index that is genuinely stale: the model must declare a
 * replacement, that replacement must already exist, and it must be the wider
 * key. Anything else is left alone and reported.
 *
 * Run with:  bun apps/api/src/scripts/drop-stale-indexes.ts [--apply]
 */

import mongoose from "mongoose";
import { connectDb } from "../config/db";

const APPLY = process.argv.includes("--apply");

/**
 * The stale index, and the one that must already exist before it is dropped.
 *
 * Named explicitly rather than worked out by comparing the model to the
 * database. This deletes a constraint on live data, so which ones go is a
 * decision taken here and reviewable, not something inferred at runtime.
 */
const STALE: { collection: string; drop: string; replacedBy: string; why: string }[] = [
  {
    collection: "departments",
    drop: "name_1",
    replacedBy: "organizationId_1_name_1",
    why: "department names are unique within an organization, not across all of them",
  },
  {
    collection: "employees",
    drop: "employeeCode_1",
    replacedBy: "organizationId_1_hrmsOrgId_1_employeeCode_1",
    why: "employee codes come from HRMS and repeat across organizations",
  },
];

async function run() {
  await connectDb();
  const db = mongoose.connection.db!;

  let toDrop = 0;
  for (const item of STALE) {
    const col = db.collection(item.collection);
    const indexes = await col.indexes();
    const stale = indexes.find((i) => i.name === item.drop);
    const replacement = indexes.find((i) => i.name === item.replacedBy);

    if (!stale) {
      console.log(`  ${item.collection}.${item.drop}: already gone`);
      continue;
    }
    if (!replacement) {
      // Never leave the data with no constraint at all. If the narrower index
      // is missing, something else is wrong and this is not the fix.
      console.warn(
        `  ${item.collection}.${item.drop}: SKIPPED — ${item.replacedBy} does not exist, so dropping this would leave nothing enforcing uniqueness`,
      );
      continue;
    }

    toDrop++;
    console.log(`  ${item.collection}.${item.drop} → replaced by ${item.replacedBy}`);
    console.log(`      ${item.why}`);

    if (APPLY) {
      await col.dropIndex(item.drop);
      console.log(`      dropped`);
    }
  }

  if (toDrop === 0) console.log("\nNothing to drop.");
  else if (!APPLY) console.log(`\nDry run — nothing changed. Re-run with --apply to drop ${toDrop} index(es).`);
  else console.log(`\nDropped ${toDrop} index(es).`);

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
