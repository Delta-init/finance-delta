import jwt, { type SignOptions } from "jsonwebtoken";
import { createHash, randomBytes } from "node:crypto";
import { env } from "../config/env";

export interface AccessTokenClaims {
  sub: string;             // userId
  org: string;             // organizationId (empty string for super-admin before org selection)
  role: string;            // role key (empty for super-admin without org)
  perms: string[];         // permissions snapshot
  superAdmin?: boolean;    // platform-level super admin flag
  pendingOrgSelect?: boolean; // intermediate token issued for multi-org picker
}

export function signAccessToken(claims: AccessTokenClaims): string {
  return jwt.sign(claims, env.JWT_ACCESS_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL as SignOptions["expiresIn"],
  });
}

/** Short-lived pending token for the org-picker step (5 min TTL). */
export function signPendingOrgToken(userId: string): string {
  return jwt.sign(
    { sub: userId, org: "", role: "", perms: [], pendingOrgSelect: true } satisfies AccessTokenClaims,
    env.JWT_ACCESS_SECRET,
    { expiresIn: "5m" },
  );
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  return jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenClaims;
}

/** Opaque refresh tokens: high-entropy random, stored as a hash for revocation. */
export function generateRefreshToken(): string {
  return randomBytes(48).toString("base64url");
}

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
