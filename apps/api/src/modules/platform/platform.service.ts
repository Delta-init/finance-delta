import { Types } from "mongoose";
import type { CreateOrganizationInput, InviteMemberInput } from "@delta/shared";
import { AppError } from "../../lib/http";
import { hashPassword } from "../../lib/password";
import { Organization } from "../organization/organization.model";
import { User } from "../user/user.model";
import { Role } from "../role/role.model";
import { seedDefaultRoles } from "../role/role.service";

export interface OrgListItem {
  id: string;
  name: string;
  legalName: string;
  baseCurrency: string;
  memberCount: number;
  createdAt: string;
}

export interface MemberListItem {
  id: string;
  name: string;
  email: string;
  roleKey: string;
  roleName: string;
  status: string;
  memberStatus: string;
}

export async function listOrganizations(): Promise<OrgListItem[]> {
  const orgs = await Organization.find().sort({ createdAt: -1 });

  const results: OrgListItem[] = await Promise.all(
    orgs.map(async (org) => {
      const memberCount = await User.countDocuments({
        "memberships.organizationId": org._id,
        "memberships.status": "active",
      });
      return {
        id: org._id.toString(),
        name: org.name,
        legalName: (org.legalName as string | undefined) ?? "",
        baseCurrency: (org.baseCurrency as string | undefined) ?? "AED",
        memberCount,
        createdAt: (org as unknown as { createdAt: Date }).createdAt.toISOString(),
      };
    }),
  );
  return results;
}

export async function createOrganization(input: CreateOrganizationInput): Promise<OrgListItem> {
  const org = await Organization.create({
    name: input.name,
    legalName: input.legalName ?? "",
    baseCurrency: input.baseCurrency ?? "AED",
  });

  await seedDefaultRoles(org._id.toString());

  return {
    id: org._id.toString(),
    name: org.name,
    legalName: (org.legalName as string | undefined) ?? "",
    baseCurrency: (org.baseCurrency as string | undefined) ?? "AED",
    memberCount: 0,
    createdAt: (org as unknown as { createdAt: Date }).createdAt.toISOString(),
  };
}

export async function listMembers(orgId: string): Promise<MemberListItem[]> {
  const users = await User.find({ "memberships.organizationId": new Types.ObjectId(orgId) });

  const results: MemberListItem[] = [];
  for (const u of users) {
    const membership = u.memberships.find((m) => m.organizationId.equals(orgId));
    if (!membership) continue;
    const role = await Role.findById(membership.roleId).select("key name");
    results.push({
      id: u._id.toString(),
      name: u.name,
      email: u.email,
      roleKey: role?.key ?? "",
      roleName: role?.name ?? "",
      status: u.status,
      memberStatus: membership.status,
    });
  }
  return results;
}

export async function inviteMember(orgId: string, input: InviteMemberInput): Promise<MemberListItem> {
  const role = await Role.findOne({ _id: input.roleId, organizationId: orgId });
  if (!role) throw new AppError("VALIDATION_ERROR", "Invalid role for this organization");

  const existing = await User.findOne({ email: input.email.toLowerCase() });
  if (existing) {
    const alreadyMember = existing.memberships.some((m) => m.organizationId.equals(orgId));
    if (alreadyMember) throw new AppError("CONFLICT", "User is already a member of this organization");

    existing.memberships.push({
      organizationId: new Types.ObjectId(orgId),
      roleId: role._id,
      status: "active",
    });
    await existing.save();
    return {
      id: existing._id.toString(),
      name: existing.name,
      email: existing.email,
      roleKey: role.key,
      roleName: role.name,
      status: existing.status,
      memberStatus: "active",
    };
  }

  if (!input.password) throw new AppError("VALIDATION_ERROR", "Password required for new users");

  const user = await User.create({
    name: input.name,
    email: input.email,
    passwordHash: await hashPassword(input.password),
    isSuperAdmin: false,
    status: "active",
    memberships: [{ organizationId: new Types.ObjectId(orgId), roleId: role._id, status: "active" }],
  });

  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    roleKey: role.key,
    roleName: role.name,
    status: "active",
    memberStatus: "active",
  };
}

export interface RoleListItem { id: string; key: string; name: string }

export async function listOrgRoles(orgId: string): Promise<RoleListItem[]> {
  const roles = await Role.find({ organizationId: orgId }).sort({ name: 1 }).select("key name");
  return roles.map((r) => ({ id: r._id.toString(), key: r.key, name: r.name }));
}

export async function removeMember(orgId: string, userId: string): Promise<void> {
  const user = await User.findById(userId);
  if (!user) throw new AppError("NOT_FOUND", "User not found");

  const idx = user.memberships.findIndex((m) => m.organizationId.equals(orgId));
  if (idx === -1) throw new AppError("NOT_FOUND", "User is not a member of this organization");

  user.memberships.splice(idx, 1);
  await user.save();
}
