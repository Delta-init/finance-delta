import { Types } from "mongoose";
import { AppError } from "../../lib/http";
import { Organization } from "../organization/organization.model";
import { Role } from "../role/role.model";
import { User } from "../user/user.model";

/**
 * Answering the Root portal's questions about this server's people.
 *
 * Provisioning was the first half: the portal could create an account here.
 * But it then had no way to see what it had created, and the role it recorded
 * was whatever an administrator had typed into a box. The two could drift
 * apart for months without anybody noticing, and the portal would keep
 * reporting the role it remembered rather than the one in force.
 *
 * So this server answers three things: which roles it actually has, what a
 * given account actually holds, and — when asked — changes it.
 */

/** Which organization, insisted upon rather than guessed. */
async function resolveOrg(remoteOrgId?: string) {
  if (!remoteOrgId) {
    throw new AppError(
      "VALIDATION_ERROR",
      "This finance server holds more than one organization, so the portal must say which — set it on the registry entry.",
    );
  }
  if (!Types.ObjectId.isValid(remoteOrgId)) {
    throw new AppError("VALIDATION_ERROR", `"${remoteOrgId}" is not a valid organization id`);
  }
  const org = await Organization.findById(remoteOrgId).select("name");
  if (!org) throw new AppError("NOT_FOUND", "No such organization on this server");
  return org;
}

export interface PortalRole {
  key: string;
  name: string;
  description: string;
  permissions: string[];
  isSystem: boolean;
}

/**
 * The roles this organization has, with what each one permits.
 *
 * The permissions travel with the role on purpose. A root admin choosing
 * between "accountant" and "salesperson" for somebody is making a decision
 * about what that person will be able to do, and a bare list of names asks
 * them to make it from memory of a system they may never have used.
 */
export async function listRolesForPortal(remoteOrgId?: string): Promise<{
  organization: string;
  roles: PortalRole[];
}> {
  const org = await resolveOrg(remoteOrgId);
  const roles = await Role.find({ organizationId: org._id })
    .select("key name description permissions isSystem")
    .sort({ name: 1 })
    .lean();

  return {
    organization: org.name,
    roles: roles.map((r) => ({
      key: r.key,
      name: r.name,
      description: r.description ?? "",
      permissions: r.permissions ?? [],
      isSystem: Boolean(r.isSystem),
    })),
  };
}

export interface PortalUserState {
  exists: boolean;
  /** Present on this server at all, but not a member of the organization asked about. */
  inOrganization: boolean;
  name: string;
  email: string;
  status: string;
  membershipStatus: string | null;
  roleKey: string | null;
  roleName: string | null;
  permissions: string[];
  lastLoginAt: string | null;
}

/**
 * What an account actually holds here, right now.
 *
 * Deliberately says "does not exist" rather than erroring: the portal asks
 * this about everybody it knows, and most of them will legitimately have no
 * account on any given server. A 404 would make the ordinary case look like a
 * fault and bury the real ones.
 */
export async function describeUserForPortal(input: {
  email: string;
  remoteOrgId?: string;
}): Promise<PortalUserState> {
  const org = await resolveOrg(input.remoteOrgId);
  const email = input.email.toLowerCase().trim();
  if (!email) throw new AppError("VALIDATION_ERROR", "email is required");

  const blank: PortalUserState = {
    exists: false, inOrganization: false, name: "", email,
    status: "", membershipStatus: null, roleKey: null, roleName: null,
    permissions: [], lastLoginAt: null,
  };

  const user = await User.findOne({ email }).select("name email status memberships lastLoginAt");
  if (!user) return blank;

  const membership = user.memberships.find((m) => m.organizationId.equals(org._id));
  if (!membership) {
    return {
      ...blank,
      exists: true,
      name: user.name,
      status: user.status ?? "",
      lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
    };
  }

  const role = await Role.findById(membership.roleId).select("key name permissions").lean();

  return {
    exists: true,
    inOrganization: true,
    name: user.name,
    email: user.email,
    status: user.status ?? "",
    membershipStatus: membership.status ?? null,
    roleKey: role?.key ?? null,
    roleName: role?.name ?? null,
    permissions: role?.permissions ?? [],
    lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
  };
}

/**
 * Change what somebody holds here, because the portal said so.
 *
 * Only ever touches the membership in the organization named — never the
 * account itself, and never a membership in another organization. A root
 * admin editing somebody's finance role in Bangalore should not be able to
 * reach into the Dubai books by accident.
 *
 * Will not create anything. Provisioning is its own endpoint and its own
 * decision; if this created accounts as a side effect of an edit, a typo in
 * an email address would quietly make a second one.
 */
export async function setUserRoleFromPortal(input: {
  email: string;
  role?: string;
  status?: string;
  remoteOrgId?: string;
}): Promise<{ detail: string; roleKey: string; membershipStatus: string }> {
  const org = await resolveOrg(input.remoteOrgId);
  const email = input.email.toLowerCase().trim();
  if (!email) throw new AppError("VALIDATION_ERROR", "email is required");
  if (!input.role && !input.status) {
    throw new AppError("VALIDATION_ERROR", "Nothing to change: give a role, a status, or both");
  }

  const user = await User.findOne({ email });
  if (!user) {
    throw new AppError("NOT_FOUND", `${email} has no account on this server — create one first`);
  }
  const membership = user.memberships.find((m) => m.organizationId.equals(org._id));
  if (!membership) {
    throw new AppError("NOT_FOUND", `${email} is not a member of ${org.name} — create one first`);
  }

  const changes: string[] = [];

  if (input.role) {
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
    if (!membership.roleId.equals(role._id)) {
      membership.roleId = role._id;
      changes.push(`role to ${role.name}`);
    }
  }

  if (input.status) {
    const status = input.status.trim().toLowerCase();
    if (!["active", "invited", "suspended"].includes(status)) {
      throw new AppError("VALIDATION_ERROR", `"${status}" is not a membership status here`);
    }
    if (membership.status !== status) {
      membership.status = status as typeof membership.status;
      changes.push(`membership to ${status}`);
    }
  }

  if (changes.length) {
    user.markModified("memberships");
    await user.save();
  }

  const finalRole = await Role.findById(membership.roleId).select("key").lean();

  return {
    detail: changes.length
      ? `Changed ${email}'s ${changes.join(" and ")} in ${org.name}`
      : `${email} already held that in ${org.name}`,
    roleKey: finalRole?.key ?? "",
    membershipStatus: membership.status ?? "active",
  };
}
