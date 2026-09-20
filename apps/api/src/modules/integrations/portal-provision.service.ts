import { Types } from "mongoose";
import { randomBytes } from "node:crypto";
import { AppError } from "../../lib/http";
import { hashPassword } from "../../lib/password";
import { Organization } from "../organization/organization.model";
import { Role } from "../role/role.model";
import { User } from "../user/user.model";

/**
 * Creating an account because the Root portal asked.
 *
 * Signing in from the portal deliberately refuses an unknown person: this
 * server believes whatever the portal vouches for, and an account appearing
 * because a token arrived would turn a spoofed portal into an instant account.
 * That refusal stands. This is the other half — a root admin, deciding on
 * purpose, one person at a time.
 *
 * Which is why it is a separate endpoint with its own secret rather than a
 * flag on the sign-in: the two are different acts and should fail differently.
 */

/** No password is ever set to something somebody could be told. */
function unusablePassword(): string {
  return randomBytes(24).toString("hex");
}

export async function provisionFromPortal(input: {
  email: string;
  name: string;
  role: string;
  remoteOrgId?: string;
}): Promise<{ created: boolean; userId: string; detail: string }> {
  const email = input.email.toLowerCase().trim();
  if (!email) throw new AppError("VALIDATION_ERROR", "email is required");

  /*
   * Which organization. This deployment holds more than one, so the portal has
   * to say, and a guess would put somebody in the wrong company's books.
   */
  if (!input.remoteOrgId) {
    throw new AppError(
      "VALIDATION_ERROR",
      "This finance server holds more than one organization, so the portal must say which — set it on the registry entry.",
    );
  }
  if (!Types.ObjectId.isValid(input.remoteOrgId)) {
    throw new AppError("VALIDATION_ERROR", `"${input.remoteOrgId}" is not a valid organization id`);
  }
  const org = await Organization.findById(input.remoteOrgId).select("name");
  if (!org) throw new AppError("NOT_FOUND", "No such organization on this server");

  /*
   * The role, by key, within that organization.
   *
   * Refused rather than defaulted. A provisioning call naming a role this
   * organization does not have is a mistake somebody should see — quietly
   * falling back to the narrowest role would hand somebody an account that
   * silently cannot do their job, and to the widest would be far worse.
   */
  const roleKey = input.role.trim().toLowerCase();
  const role = await Role.findOne({ organizationId: org._id, key: roleKey });
  if (!role) {
    const available = (await Role.find({ organizationId: org._id }).select("key").lean())
      .map((r) => r.key)
      .join(", ");
    throw new AppError(
      "VALIDATION_ERROR",
      `${org.name} has no role "${roleKey}". It has: ${available}.`,
    );
  }

  const existing = await User.findOne({ email });
  if (existing) {
    const already = existing.memberships.some((m) => m.organizationId.equals(org._id));
    if (already) {
      // Idempotent: the portal retries, and an administrator clicking twice
      // should not be an error they have to interpret.
      return {
        created: false,
        userId: existing._id.toString(),
        detail: `${email} already belongs to ${org.name}`,
      };
    }
    existing.memberships.push({
      organizationId: org._id,
      roleId: role._id,
      status: "active",
    } as never);
    await existing.save();
    return {
      created: true,
      userId: existing._id.toString(),
      detail: `Added ${email} to ${org.name} as ${role.name}`,
    };
  }

  /*
   * A password nobody knows, including whoever asked for the account.
   *
   * They arrive through the portal, so they never type one here. Setting
   * something guessable — or something an administrator could pass on — would
   * quietly create a second way in that nobody is watching.
   */
  const user = await User.create({
    name: input.name?.trim() || email.split("@")[0],
    email,
    passwordHash: await hashPassword(unusablePassword()),
    status: "active",
    isSuperAdmin: false,
    memberships: [{ organizationId: org._id, roleId: role._id, status: "active" }],
  });

  return {
    created: true,
    userId: user._id.toString(),
    detail: `Created ${email} in ${org.name} as ${role.name}`,
  };
}
