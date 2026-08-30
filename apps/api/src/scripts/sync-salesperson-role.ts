/**
 * Bring the Salesperson role in each organization back in line with the code.
 *
 * `seed-system-roles` only ever adds a missing role — deliberately, so it
 * cannot wipe permissions an administrator has changed. That leaves an existing
 * Salesperson role frozen at whatever it was seeded with, and this one changed:
 * the organization-wide invoice permissions became the `:own` variants, so a
 * salesperson sees the invoices they entered rather than everybody's.
 *
 * Refuses to touch a role somebody has customised — if the stored permissions
 * are neither the old set nor the new one, an administrator has edited it and
 * quietly overwriting that would take away access they granted on purpose.
 *
 * Prints what it would do and changes nothing without --apply.
 *
 * Run with:  bun apps/api/src/scripts/sync-salesperson-role.ts [--apply]
 */

import mongoose from "mongoose";
import { SYSTEM_ROLES } from "@delta/shared";
import { connectDb } from "../config/db";
import { Role } from "../modules/role/role.model";
import { User } from "../modules/user/user.model";

const APPLY = process.argv.includes("--apply");

/** What the role was seeded with while invoices were organization-wide. */
const PREVIOUS = [
  "customer:read",
  "customer:write",
  "customer:create",
  "customer:update",
  "quotation:read",
  "quotation:create",
  "quotation:update",
  "quotation:delete",
  "salesorder:read",
  "salesorder:create",
  "salesorder:update",
  "tag:read",
  "tag:create",
  "tag:update",
  "invoice:read",
  "invoice:write",
];

const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

async function run() {
  await connectDb();
  const wanted = SYSTEM_ROLES.find((r) => r.key === "salesperson")!.permissions;

  const roles = await Role.find({ key: "salesperson" });
  if (roles.length === 0) {
    console.log("No Salesperson role anywhere. Run seed-system-roles first.");
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
