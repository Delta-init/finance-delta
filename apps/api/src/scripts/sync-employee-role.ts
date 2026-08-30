/**
 * Bring the Employee role in each organization back in line with the code.
 *
 * `seed-system-roles` only ever adds a missing role — deliberately, so it
 * cannot wipe permissions an administrator has changed. That leaves an
 * existing Employee role frozen at whatever it was seeded with, and this one
 * changed: expenses came out and customer:create went in, because the role is
 * now for taking enrolments rather than for claims.
 *
 * Refuses to touch a role somebody has customised — if the stored permissions
 * are neither the old set nor the new one, an administrator has edited it and
 * quietly overwriting that would take away access they granted on purpose.
 *
 * Prints what it would do and changes nothing without --apply.
 *
 * Run with:  bun apps/api/src/scripts/sync-employee-role.ts [--apply]
 */

import mongoose from "mongoose";
import { SYSTEM_ROLES } from "@delta/shared";
import { connectDb } from "../config/db";
import { Role } from "../modules/role/role.model";
import { User } from "../modules/user/user.model";

const APPLY = process.argv.includes("--apply");

/** What the role was seeded with before enrolments existed. */
const PREVIOUS = [
  "expense:read:own",
  "expense:write:own",
  "invoice:read:own",
  "invoice:write:own",
  "customer:read",
];

const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

async function run() {
  await connectDb();
  const wanted = SYSTEM_ROLES.find((r) => r.key === "employee")!.permissions;

  const roles = await Role.find({ key: "employee" });
  if (roles.length === 0) {
    console.log("No Employee role anywhere. Run seed-system-roles first.");
    await mongoose.disconnect();
    return;
  }

  let toChange = 0;
  for (const role of roles) {
    const org = await mongoose.connection.db!
      .collection("organizations")
      .findOne({ _id: role.organizationId });
    const name = String(org?.name ?? role.organizationId);
    const current = (role.permissions ?? []) as string[];
    const holders = await User.countDocuments({ "memberships.roleId": role._id });

    if (same(current, wanted)) {
      console.log(`  ${name}: already current`);
      continue;
    }
    if (!same(current, PREVIOUS)) {
      console.warn(
        `  ${name}: SKIPPED — permissions do not match what was seeded, so somebody has edited them.\n` +
          `      has:  ${JSON.stringify(current)}\n` +
          `      code: ${JSON.stringify(wanted)}`,
      );
      continue;
    }

    toChange++;
    console.log(`  ${name}: ${holders} holder(s)`);
    console.log(`      - ${current.filter((p) => !wanted.includes(p as never)).join(", ") || "nothing"}`);
    console.log(`      + ${wanted.filter((p) => !current.includes(p)).join(", ") || "nothing"}`);

    if (APPLY) {
      role.set({ permissions: [...wanted] });
      await role.save();
      console.log("      updated");
    }
  }

  if (toChange === 0) console.log("\nNothing to change.");
  else if (!APPLY) console.log(`\nDry run — nothing written. Re-run with --apply to update ${toChange} role(s).`);
  else console.log(`\nUpdated ${toChange} role(s).`);

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
