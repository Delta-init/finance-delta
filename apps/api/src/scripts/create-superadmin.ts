/**
 * Creates a super admin user (or upgrades an existing user to super admin).
 * Run with: bun --env-file=apps/api/.env apps/api/src/scripts/create-superadmin.ts
 */

import { connectDb } from "../config/db";
import { hashPassword } from "../lib/password";
import mongoose from "mongoose";

const EMAIL = "admin@delta.com";
const PASSWORD = "Delta@2025!";

async function run() {
  await connectDb();
  const db = mongoose.connection.db!;
  const users = db.collection("users");

  const existing = await users.findOne({ email: EMAIL });

  if (existing) {
    await users.updateOne(
      { email: EMAIL },
      { $set: { isSuperAdmin: true, status: "active" } },
    );
    console.log(`✓ Upgraded existing user to super admin: ${EMAIL}`);
  } else {
    const passwordHash = await hashPassword(PASSWORD);
    await users.insertOne({
      name: "Super Admin",
      email: EMAIL,
      passwordHash,
      isSuperAdmin: true,
      status: "active",
      memberships: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    console.log(`✓ Created super admin user: ${EMAIL}`);
  }

  console.log(`\nCredentials:`);
  console.log(`  Email   : ${EMAIL}`);
  console.log(`  Password: ${PASSWORD}`);

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
