/**
 * Ensure every organization has every system role.
 *
 * `seedDefaultRoles` runs when an organization is created, so an organization
 * that predates a new system role never gets it. This backfills them.
 *
 * Adds missing roles and only adds the new standard budget permissions to
 * built-in manager, accountant, and employee roles. Existing grants are kept.
 *
 * Run with:  bun apps/api/src/scripts/seed-system-roles.ts [--apply]
 */
import mongoose from "mongoose";
import { SYSTEM_ROLES } from "@delta/shared";
import { connectDb } from "../config/db";
import { Role } from "../modules/role/role.model";
import { seedDefaultRoles } from "../modules/role/role.service";

const APPLY = process.argv.includes("--apply");
const BUDGET_ROLE_PERMISSIONS: Record<string, string[]> = {
  manager: ["budget:read", "budget:approve"],
  accountant: ["budget:read", "budget:manage", "budget:approve"],
  employee: ["budget:read:own", "budget:request"],
};

async function run() {
  await connectDb();
  const orgs = await mongoose.connection.db!.collection("organizations").find({}).toArray();
  console.log(`${orgs.length} organization(s)\n`);

  let missingTotal = 0;
  let permissionTotal = 0;
  for (const org of orgs) {
    const roles = await Role.find({ organizationId: org._id, isSystem: true });
    const have = new Set(roles.map((r) => r.key));
    const missing = SYSTEM_ROLES.filter((r) => !have.has(r.key)).map((r) => r.key);
    missingTotal += missing.length;
    const permissionAdds = roles.flatMap((role) => (BUDGET_ROLE_PERMISSIONS[role.key] ?? []).filter((p) => !role.permissions.includes(p)).map((p) => ({ role, permission: p })));
    permissionTotal += permissionAdds.length;
    console.log(`  ${String(org.name)}: ${missing.length ? `missing roles ${missing.join(", ")}` : "roles complete"}${permissionAdds.length ? ` · add ${permissionAdds.map((p) => `${p.role.key}:${p.permission}`).join(", ")}` : ""}`);
    if (APPLY && missing.length) await seedDefaultRoles(String(org._id));
    if (APPLY) {
      for (const add of permissionAdds) await Role.updateOne({ _id: add.role._id }, { $addToSet: { permissions: add.permission } });
    }
  }

  if (missingTotal === 0 && permissionTotal === 0) console.log("\nNothing to add.");
  else if (!APPLY) console.log(`\nDry run — nothing written. Re-run with --apply to add ${missingTotal} role(s) and ${permissionTotal} budget permission(s).`);
  else console.log(`\nAdded ${missingTotal} role(s) and ${permissionTotal} budget permission(s).`);

  await mongoose.disconnect();
}

run().catch((err) => { console.error(err); process.exit(1); });
