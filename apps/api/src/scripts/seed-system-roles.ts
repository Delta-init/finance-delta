/**
 * Ensure every organization has every system role.
 *
 * `seedDefaultRoles` runs when an organization is created, so an organization
 * that predates a new system role never gets it. This backfills them.
 *
 * Only ever adds. An existing role of the same key is left exactly as it is,
 * including any permissions an administrator has changed.
 *
 * Run with:  bun apps/api/src/scripts/seed-system-roles.ts [--apply]
 */
import mongoose from "mongoose";
import { SYSTEM_ROLES } from "@delta/shared";
import { connectDb } from "../config/db";
import { Role } from "../modules/role/role.model";
import { seedDefaultRoles } from "../modules/role/role.service";

const APPLY = process.argv.includes("--apply");

async function run() {
  await connectDb();
  const orgs = await mongoose.connection.db!.collection("organizations").find({}).toArray();
  console.log(`${orgs.length} organization(s)\n`);

  let missingTotal = 0;
  for (const org of orgs) {
    const have = new Set(
      (await Role.find({ organizationId: org._id, isSystem: true }).select("key")).map((r) => r.key),
    );
    const missing = SYSTEM_ROLES.filter((r) => !have.has(r.key)).map((r) => r.key);
    missingTotal += missing.length;
    console.log(`  ${String(org.name)}: ${missing.length ? `missing ${missing.join(", ")}` : "complete"}`);
    if (APPLY && missing.length) await seedDefaultRoles(String(org._id));
  }

  if (missingTotal === 0) console.log("\nNothing to add.");
  else if (!APPLY) console.log(`\nDry run — nothing written. Re-run with --apply to add ${missingTotal} role(s).`);
  else console.log(`\nAdded ${missingTotal} role(s).`);

  await mongoose.disconnect();
}

run().catch((err) => { console.error(err); process.exit(1); });
