/**
 * Seeds the first organization, its system roles, the initial admin user,
 * and a platform-level super admin.
 * Idempotent: safe to run more than once.
 * Run with: bun --env-file=apps/api/.env apps/api/src/scripts/seed.ts
 */
import { SYSTEM_ROLES, ADMIN_ROLE_KEY } from "@delta/shared";
import { Types } from "mongoose";
import { env } from "../config/env";
import { connectDb, disconnectDb } from "../config/db";
import { logger } from "../lib/logger";
import { hashPassword } from "../lib/password";
import { Organization } from "../modules/organization/organization.model";
import { Role } from "../modules/role/role.model";
import { User } from "../modules/user/user.model";

async function seed() {
  await connectDb();

  // ── 1. Organization ──────────────────────────────────────────────────────────
  let org = await Organization.findOne({ name: env.SEED_ORG_NAME });
  if (!org) {
    org = await Organization.create({ name: env.SEED_ORG_NAME });
    logger.info(`Created organization "${org.name}"`);
  } else {
    logger.info(`Organization already exists: "${org.name}"`);
  }

  // ── 2. System roles ──────────────────────────────────────────────────────────
  for (const def of SYSTEM_ROLES) {
    await Role.updateOne(
      { organizationId: org._id, key: def.key },
      {
        $set: {
          name: def.name,
          description: def.description,
          permissions: def.permissions,
          isSystem: true,
        },
        $setOnInsert: { organizationId: org._id, key: def.key },
      },
      { upsert: true },
    );
  }
  logger.info(`Ensured ${SYSTEM_ROLES.length} system roles`);

  const adminRole = await Role.findOne({ organizationId: org._id, key: ADMIN_ROLE_KEY });
  if (!adminRole) throw new Error("Admin role missing after seed");

  // ── 3. Org admin user (member of the seeded org) ─────────────────────────────
  const adminEmail = env.SEED_ADMIN_EMAIL.toLowerCase();
  let adminUser = await User.findOne({ email: adminEmail });
  if (adminUser) {
    // Ensure membership exists in the seeded org
    const hasMembership = adminUser.memberships.some((m) =>
      m.organizationId.equals(org!._id),
    );
    if (!hasMembership) {
      adminUser.memberships.push({
        organizationId: org._id as Types.ObjectId,
        roleId: adminRole._id as Types.ObjectId,
        status: "active",
      });
      await adminUser.save();
      logger.info(`Added org membership for existing admin: ${adminEmail}`);
    } else {
      logger.info(`Admin user already exists: ${adminEmail}`);
    }
  } else {
    await User.create({
      name: env.SEED_ADMIN_NAME,
      email: adminEmail,
      passwordHash: await hashPassword(env.SEED_ADMIN_PASSWORD),
      isSuperAdmin: false,
      status: "active",
      memberships: [
        {
          organizationId: org._id,
          roleId: adminRole._id,
          status: "active",
        },
      ],
    });
    logger.info(`Created org admin: ${adminEmail}`);
  }

  // ── 4. Platform super admin (no org membership required) ────────────────────
  const superEmail = env.SEED_SUPER_ADMIN_EMAIL.toLowerCase();
  const existingSuper = await User.findOne({ email: superEmail });
  if (existingSuper) {
    if (!existingSuper.isSuperAdmin) {
      existingSuper.isSuperAdmin = true;
      await existingSuper.save();
      logger.info(`Upgraded existing user to super admin: ${superEmail}`);
    } else {
      logger.info(`Super admin already exists: ${superEmail}`);
    }
  } else {
    await User.create({
      name: env.SEED_SUPER_ADMIN_NAME,
      email: superEmail,
      passwordHash: await hashPassword(env.SEED_SUPER_ADMIN_PASSWORD),
      isSuperAdmin: true,
      status: "active",
      memberships: [],
    });
    logger.info(`Created super admin: ${superEmail}`);
  }

  logger.info("✅ Seed complete");
  logger.info(`   Org admin  → ${adminEmail} / ${env.SEED_ADMIN_PASSWORD}`);
  logger.info(`   Super admin → ${superEmail} / ${env.SEED_SUPER_ADMIN_PASSWORD}`);

  await disconnectDb();
}

seed().catch(async (err) => {
  logger.error({ err }, "Seed failed");
  await disconnectDb();
  process.exit(1);
});
