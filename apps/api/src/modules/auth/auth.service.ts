import { Types } from "mongoose";
import type { AuthResult, AuthUser } from "@delta/shared";
import { AppError } from "../../lib/http";
import {
  generateRefreshToken,
  hashRefreshToken,
  signAccessToken,
} from "../../lib/jwt";
import { verifyPassword } from "../../lib/password";
import { env } from "../../config/env";
import { User } from "../user/user.model";
import { Role, type RoleDoc } from "../role/role.model";
import { RefreshToken } from "./refreshToken.model";

function buildAuthUser(
  user: { _id: Types.ObjectId; name: string; email: string; organizationId: Types.ObjectId },
  role: RoleDoc,
): AuthUser {
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    organizationId: user.organizationId.toString(),
    roleKey: role.key,
    roleName: role.name,
    permissions: role.permissions ?? [],
  };
}

async function issueTokens(authUser: AuthUser): Promise<AuthResult> {
  const accessToken = signAccessToken({
    sub: authUser.id,
    org: authUser.organizationId,
    role: authUser.roleKey,
    perms: authUser.permissions,
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

export async function login(
  email: string,
  password: string,
): Promise<AuthResult> {
  const user = await User.findOne({ email: email.toLowerCase() });
  // Constant-ish failure message to avoid leaking which part was wrong.
  if (!user) throw new AppError("UNAUTHENTICATED", "Invalid email or password");
  if (user.status === "suspended") {
    throw new AppError("FORBIDDEN", "This account is suspended");
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) throw new AppError("UNAUTHENTICATED", "Invalid email or password");

  const role = await Role.findById(user.roleId);
  if (!role) throw new AppError("INTERNAL", "User role missing");

  user.lastLoginAt = new Date();
  await user.save();

  return issueTokens(buildAuthUser(user, role));
}

export async function refresh(refreshToken: string): Promise<AuthResult> {
  const tokenHash = hashRefreshToken(refreshToken);
  const existing = await RefreshToken.findOne({ tokenHash });
  if (!existing || existing.expiresAt.getTime() < Date.now()) {
    throw new AppError("UNAUTHENTICATED", "Invalid or expired refresh token");
  }

  // Rotate: delete the presented token before issuing a new one.
  await existing.deleteOne();

  const user = await User.findById(existing.userId);
  if (!user || user.status === "suspended") {
    throw new AppError("UNAUTHENTICATED", "Account no longer active");
  }
  const role = await Role.findById(user.roleId);
  if (!role) throw new AppError("INTERNAL", "User role missing");

  return issueTokens(buildAuthUser(user, role));
}

export async function logout(refreshToken: string): Promise<void> {
  await RefreshToken.deleteOne({ tokenHash: hashRefreshToken(refreshToken) });
}

export async function getMe(userId: string): Promise<AuthUser> {
  const user = await User.findById(userId);
  if (!user) throw new AppError("NOT_FOUND", "User not found");
  const role = await Role.findById(user.roleId);
  if (!role) throw new AppError("INTERNAL", "User role missing");
  return buildAuthUser(user, role);
}
