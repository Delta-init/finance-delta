/**
 * Seeds the first organization, its system roles, and the initial admin user.
 * Idempotent: safe to run more than once. Run with `bun run seed`.
 */
import { SYSTEM_ROLES, ADMIN_ROLE_KEY } from "@delta/shared";
import { env } from "../config/env";
import { connectDb, disconnectDb } from "../config/db";
import { logger } from "../lib/logger";
import { hashPassword } from "../lib/password";
import { Organization } from "../modules/organization/organization.model";
import { Role } from "../modules/role/role.model";
import { User } from "../modules/user/user.model";

async function seed() {
  await connectDb();

  // 1. Organization
  let org = await Organization.findOne({ name: env.SEED_ORG_NAME });
  if (!org) {
    org = await Organization.create({ name: env.SEED_ORG_NAME });
    logger.info(`Created organization "${org.name}"`);
  }

  // 2. System roles
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

  // 3. Admin user
  const adminRole = await Role.findOne({
    organizationId: org._id,
    key: ADMIN_ROLE_KEY,
  });
  if (!adminRole) throw new Error("Admin role missing after seed");

  const existing = await User.findOne({
    organizationId: org._id,
    email: env.SEED_ADMIN_EMAIL.toLowerCase(),
  });
  if (existing) {
    logger.info(`Admin user already exists: ${env.SEED_ADMIN_EMAIL}`);
  } else {
    await User.create({
      organizationId: org._id,
      name: env.SEED_ADMIN_NAME,
      email: env.SEED_ADMIN_EMAIL.toLowerCase(),
      passwordHash: await hashPassword(env.SEED_ADMIN_PASSWORD),
      roleId: adminRole._id,
      status: "active",
    });
    logger.info(
      `Created admin user ${env.SEED_ADMIN_EMAIL} (password from SEED_ADMIN_PASSWORD)`,
    );
  }

  logger.info("✅ Seed complete");
  await disconnectDb();
}

seed().catch(async (err) => {
  logger.error({ err }, "Seed failed");
  await disconnectDb();
  process.exit(1);
});
