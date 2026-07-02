/**
 * One-time migration: converts old User documents that have top-level
 * `organizationId` and `roleId` fields into the new `memberships[]` array.
 *
 * Run with:  bun apps/api/src/scripts/migrate-memberships.ts
 */

import mongoose from "mongoose";
import { connectDb } from "../config/db";
import { seedDefaultRoles } from "../modules/role/role.service";

async function run() {
  await connectDb();
  console.log("Connected to MongoDB");

  const db = mongoose.connection.db!;
  const usersCol = db.collection("users");
  const orgsCol = db.collection("organizations");

  // Find all orgs and seed their default roles if missing.
  const allOrgs = await orgsCol.find({}).toArray();
  console.log(`Found ${allOrgs.length} organization(s)`);
  for (const org of allOrgs) {
    await seedDefaultRoles(org._id.toString());
    console.log(`  Seeded roles for org: ${org.name}`);
  }

  // Migrate users that still have the old top-level organizationId field.
  const legacyUsers = await usersCol.find({ organizationId: { $exists: true } }).toArray();
  console.log(`Found ${legacyUsers.length} user(s) to migrate`);

  for (const user of legacyUsers) {
    const { organizationId, roleId, tagIds, ...rest } = user;
    const membership = {
      organizationId,
      roleId,
      status: "active",
    };

    await usersCol.updateOne(
      { _id: user._id },
      {
        $set: {
          memberships: [membership],
          isSuperAdmin: false,
        },
        $unset: { organizationId: "", roleId: "", tagIds: "" },
      },
    );
    console.log(`  Migrated user: ${user.email}`);
  }

  // Drop the old compound index { organizationId: 1, email: 1 } if it exists.
  try {
    await usersCol.dropIndex("organizationId_1_email_1");
    console.log("Dropped old index: organizationId_1_email_1");
  } catch {
    console.log("Old index not found (already dropped or never existed) — OK");
  }

  console.log("Migration complete");
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
