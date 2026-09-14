import { Types } from "mongoose";
import type { AuthSuccess, AuthUser, OrgChoiceResult, SwitchOrgInput } from "@delta/shared";
import { AppError } from "../../lib/http";
import {
  generateRefreshToken,
  hashRefreshToken,
  signAccessToken,
  signPendingOrgToken,
} from "../../lib/jwt";
import { verifyPassword } from "../../lib/password";
import { env } from "../../config/env";
import { User } from "../user/user.model";
import { Role, type RoleDoc } from "../role/role.model";
import { Organization } from "../organization/organization.model";
import { RefreshToken } from "./refreshToken.model";

type AuthResponse = AuthSuccess | OrgChoiceResult;

function buildAuthUser(
  user: { _id: Types.ObjectId; name: string; email: string; isSuperAdmin?: boolean },
  org: { _id: Types.ObjectId; name: string; baseCurrency?: string },
  role: RoleDoc,
): AuthUser {
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    organizationId: org._id.toString(),
    orgName: org.name,
    baseCurrency: (org.baseCurrency as string | undefined) ?? "AED",
    roleKey: role.key,
    roleName: role.name,
    permissions: role.permissions ?? [],
    isSuperAdmin: user.isSuperAdmin ?? false,
  };
}

async function issueTokens(authUser: AuthUser): Promise<AuthSuccess> {
  const accessToken = signAccessToken({
    sub: authUser.id,
    org: authUser.organizationId,
    role: authUser.roleKey,
    perms: authUser.permissions,
    superAdmin: authUser.isSuperAdmin || undefined,
  });

  const refreshToken = generateRefreshToken();
  const expiresAt = new Date(
    Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  );
  await RefreshToken.create({
    userId: new Types.ObjectId(authUser.id),
    organizationId: new Types.ObjectId(authUser.organizationId),
    tokenHash: hashRefreshToken(refreshToken),
    expiresAt,
  });

  return { user: authUser, accessToken, refreshToken };
}

export async function login(email: string, password: string): Promise<AuthResponse> {
  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) throw new AppError("UNAUTHENTICATED", "Invalid email or password");
  if (user.status === "suspended") throw new AppError("FORBIDDEN", "This account is suspended");

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) throw new AppError("UNAUTHENTICATED", "Invalid email or password");

  user.lastLoginAt = new Date();
  await user.save();

  const activeMemberships = user.memberships.filter((m) => m.status === "active");

  /*
   * A super admin may work in an organization they hold no membership in —
   * switchOrg lets them, borrowing that organization's admin role. Login has
   * to honour the same choice, or theirs is the one account the memory does
   * not work for.
   *
   * Ahead of the no-memberships branch below, which hands a super admin a
   * token with no organization at all and would otherwise swallow this.
   */
  if (user.isSuperAdmin && user.lastOrganizationId) {
    const [rememberedOrg, adminRole] = await Promise.all([
      Organization.findById(user.lastOrganizationId).select("name baseCurrency"),
      Role.findOne({ organizationId: user.lastOrganizationId, key: "admin" }),
    ]);
    // Their own membership role where they have one, the organization's admin
    // role where they do not — the same rule switchOrg applies.
    const own = activeMemberships.find((m) => m.organizationId.equals(user.lastOrganizationId!));
    const role = own ? await Role.findById(own.roleId) : adminRole;
    if (rememberedOrg && role) return issueTokens(buildAuthUser(user, rememberedOrg, role));
    // Otherwise fall through: the organization is gone, or has no admin role.
  }

  if (activeMemberships.length === 0) {
    if (user.isSuperAdmin) {
      // Super admin with no org memberships — issue a no-org token; they'll select via platform.
      const accessToken = signAccessToken({
        sub: user._id.toString(),
        org: "",
        role: "",
        perms: [],
        superAdmin: true,
      });
      const refreshToken = generateRefreshToken();
      const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
      await RefreshToken.create({
        userId: user._id,
        organizationId: new Types.ObjectId("000000000000000000000000"),
        tokenHash: hashRefreshToken(refreshToken),
        expiresAt,
      });
      return {
        user: {
          id: user._id.toString(),
          name: user.name,
          email: user.email,
          organizationId: "",
          orgName: "",
          baseCurrency: "AED",
          roleKey: "",
          roleName: "",
          permissions: [],
          isSuperAdmin: true,
        },
        accessToken,
        refreshToken,
      } satisfies AuthSuccess;
    }
    throw new AppError("FORBIDDEN", "No active organization membership");
  }

  /*
   * Where this user was last working, if they may still go there.
   *
   * A membership that has since been revoked, or an organization that has been
   * deleted, falls through to the ordinary choice below rather than failing the
   * login — being unable to sign in at all is a far worse outcome than landing
   * in the wrong place.
   */
  const remembered = user.lastOrganizationId
    ? activeMemberships.find((m) => m.organizationId.equals(user.lastOrganizationId!))
    : undefined;

  if (remembered || activeMemberships.length === 1 || user.isSuperAdmin) {
    // The remembered organization when there is one, otherwise the first —
    // which is all this could do before.
    const membership = remembered ?? activeMemberships[0]!;
    const [org, role] = await Promise.all([
      Organization.findById(membership.organizationId).select("name baseCurrency"),
      Role.findById(membership.roleId),
    ]);
    if (!org || !role) throw new AppError("INTERNAL", "Organization or role not found");
    return issueTokens(buildAuthUser(user, org, role));
  }

  // Multiple orgs — return org list so the client shows the picker.
  const orgs = await Organization.find({
    _id: { $in: activeMemberships.map((m) => m.organizationId) },
  }).select("name baseCurrency");

  return {
    status: "choose_org",
    orgs: orgs.map((o) => ({
      id: o._id.toString(),
      name: o.name,
      baseCurrency: (o.baseCurrency as string) ?? "AED",
    })),
    pendingToken: signPendingOrgToken(user._id.toString()),
  } satisfies OrgChoiceResult;
}

export async function switchOrg(
  userId: string,
  isSuperAdmin: boolean,
  input: SwitchOrgInput,
): Promise<AuthSuccess> {
  const user = await User.findById(userId);
  if (!user || user.status === "suspended") {
    throw new AppError("UNAUTHENTICATED", "Account not found or suspended");
  }

  const org = await Organization.findById(input.organizationId).select("name baseCurrency");
  if (!org) throw new AppError("NOT_FOUND", "Organization not found");

  let roleId: Types.ObjectId;

  if (isSuperAdmin) {
    // Super admin can switch into any org. Use their membership role if they have one,
    // otherwise use the admin role of the target org.
    const membership = user.memberships.find((m) =>
      m.organizationId.equals(input.organizationId),
    );
    if (membership) {
      roleId = membership.roleId as Types.ObjectId;
    } else {
      const adminRole = await Role.findOne({ organizationId: input.organizationId, key: "admin" });
      if (!adminRole) throw new AppError("INTERNAL", "Admin role missing for org");
      roleId = adminRole._id;
    }
  } else {
    const membership = user.memberships.find(
      (m) => m.organizationId.equals(input.organizationId) && m.status === "active",
    );
    if (!membership) throw new AppError("FORBIDDEN", "No active membership in this organization");
    roleId = membership.roleId as Types.ObjectId;
  }

  const role = await Role.findById(roleId);
  if (!role) throw new AppError("INTERNAL", "Role not found");

  // Remembered so the next login lands here rather than back at the first
  // membership. Written after the checks above, so only a switch that was
  // actually allowed is the one that sticks.
  user.lastOrganizationId = org._id;
  await user.save();

  return issueTokens(buildAuthUser(user, org, role));
}

export async function refresh(refreshToken: string): Promise<AuthSuccess> {
  const tokenHash = hashRefreshToken(refreshToken);
  const existing = await RefreshToken.findOne({ tokenHash });
  if (!existing || existing.expiresAt.getTime() < Date.now()) {
    throw new AppError("UNAUTHENTICATED", "Invalid or expired refresh token");
  }

  await existing.deleteOne();

  const user = await User.findById(existing.userId);
  if (!user || user.status === "suspended") {
    throw new AppError("UNAUTHENTICATED", "Account no longer active");
  }

  // Super admin with no org session.
  const orgId = existing.organizationId.toString();
  if (orgId === "000000000000000000000000") {
    const accessToken = signAccessToken({
      sub: user._id.toString(),
      org: "",
      role: "",
      perms: [],
      superAdmin: true,
    });
    const newRefreshToken = generateRefreshToken();
    const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
    await RefreshToken.create({
      userId: user._id,
      organizationId: existing.organizationId,
      tokenHash: hashRefreshToken(newRefreshToken),
      expiresAt,
    });
    return {
      user: {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        organizationId: "",
        orgName: "",
        baseCurrency: "AED",
        roleKey: "",
        roleName: "",
        permissions: [],
        isSuperAdmin: true,
      },
      accessToken,
      refreshToken: newRefreshToken,
    };
  }

  const membership = user.memberships.find((m) =>
    m.organizationId.equals(existing.organizationId),
  );
  if (!membership || membership.status !== "active") {
    throw new AppError("UNAUTHENTICATED", "Membership revoked");
  }

  const [org, role] = await Promise.all([
    Organization.findById(existing.organizationId).select("name baseCurrency"),
    Role.findById(membership.roleId),
  ]);
  if (!org || !role) throw new AppError("INTERNAL", "Organization or role not found");

  return issueTokens(buildAuthUser(user, org, role));
}

export async function logout(refreshToken: string): Promise<void> {
  await RefreshToken.deleteOne({ tokenHash: hashRefreshToken(refreshToken) });
}

export async function getMe(userId: string, organizationId: string): Promise<AuthUser> {
  const user = await User.findById(userId);
  if (!user) throw new AppError("NOT_FOUND", "User not found");

  if (!organizationId) {
    return {
      id: user._id.toString(),
      name: user.name,
      email: user.email,
      organizationId: "",
      orgName: "",
      baseCurrency: "AED",
      roleKey: "",
      roleName: "",
      permissions: [],
      isSuperAdmin: user.isSuperAdmin ?? false,
    };
  }

  const membership = user.memberships.find((m) => m.organizationId.equals(organizationId));
  if (!membership) throw new AppError("NOT_FOUND", "Membership not found");

  const [org, role] = await Promise.all([
    Organization.findById(organizationId).select("name baseCurrency"),
    Role.findById(membership.roleId),
  ]);
  if (!org || !role) throw new AppError("INTERNAL", "Organization or role not found");

  return buildAuthUser(user, org, role);
}
