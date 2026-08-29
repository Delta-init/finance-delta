import { createHash, randomBytes } from "node:crypto";
import { Types } from "mongoose";
import { env } from "../../config/env";
import { AppError } from "../../lib/http";
import { logger } from "../../lib/logger";
import { hashPassword } from "../../lib/password";
import { sendNotice } from "../../lib/email";
import { User } from "../user/user.model";
import { PasswordToken } from "./passwordToken.model";
import { RefreshToken } from "./refreshToken.model";

/** How long a link stays good. An invite has to survive a weekend; a reset does not. */
const TTL = {
  invite: 7 * 24 * 60 * 60 * 1000,
  reset: 60 * 60 * 1000,
} as const;

export type TokenPurpose = "invite" | "reset";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Mint a link and record only its hash.
 *
 * Any link already outstanding for this person is spent first. Two working
 * links means the older one keeps working after the newer was issued, which is
 * exactly what somebody asking for a reset because they think their account is
 * compromised does not want.
 */
async function issue(userId: Types.ObjectId, purpose: TokenPurpose): Promise<string> {
  await PasswordToken.updateMany(
    { userId, usedAt: { $exists: false } },
    { $set: { usedAt: new Date() } },
  );
  const token = randomBytes(32).toString("base64url");
  await PasswordToken.create({
    userId,
    tokenHash: hashToken(token),
    purpose,
    expiresAt: new Date(Date.now() + TTL[purpose]),
  });
  return token;
}

function linkFor(token: string): string {
  return `${env.WEB_ORIGIN}/set-password?token=${encodeURIComponent(token)}`;
}

/**
 * Send somebody a link to set their password.
 *
 * Returns whether an email actually went out, which the caller may report to
 * an administrator who asked for an invite — but must not report to an
 * anonymous caller asking about an address.
 */
async function deliver(
  email: string,
  name: string,
  token: string,
  purpose: TokenPurpose,
): Promise<boolean> {
  const invite = purpose === "invite";
  const { sent } = await sendNotice({
    to: [email],
    subject: invite ? "Your Delta Finance account" : "Reset your Delta Finance password",
    title: invite ? `Welcome, ${name}` : "Reset your password",
    lines: invite
      ? [
          "An account has been created for you in Delta Finance.",
          "Choose a password to get started. This link is good for seven days.",
        ]
      : [
          "Somebody asked to reset the password on your account.",
          "This link is good for one hour and can be used once.",
          "If it wasn't you, ignore this — your password has not changed.",
        ],
    actionLabel: invite ? "Set your password" : "Reset your password",
    actionUrl: linkFor(token),
  });
  return sent > 0;
}

/**
 * Handle "I forgot my password".
 *
 * Deliberately says nothing about whether the address is known. An endpoint
 * that answers differently for a real account than an unknown one is a way to
 * find out who holds an account here, and it is reachable without logging in.
 * Every path through this function returns the same thing.
 *
 * A suspended account is treated as an unknown one: resetting the password
 * would not restore access, and saying so would confirm the address exists.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const user = await User.findOne({ email: email.toLowerCase().trim() });

  if (!user || user.status !== "active") {
    logger.info({ email }, "Password reset requested for unknown or inactive account");
    return;
  }

  const token = await issue(user._id, "reset");
  const delivered = await deliver(user.email, user.name, token, "reset");
  if (!delivered) {
    logger.warn({ userId: String(user._id) }, "Password reset email was not delivered");
  }
}

/**
 * Send somebody their first password link.
 *
 * Administrator-initiated, so unlike a reset it may report what happened —
 * whoever is asking already knows the account exists, having just looked at it.
 */
export async function inviteUser(
  orgId: string,
  userId: string,
): Promise<{ delivered: boolean; email: string }> {
  const user = await User.findOne({
    _id: new Types.ObjectId(userId),
    "memberships.organizationId": new Types.ObjectId(orgId),
  });
  if (!user) throw new AppError("NOT_FOUND", "User not found");
  if (user.status !== "active") {
    throw new AppError("CONFLICT", "This account is suspended, so an invite would not let them in");
  }
  if (!user.email) {
    throw new AppError("VALIDATION_ERROR", "This account has no email address to send to");
  }

  const token = await issue(user._id, "invite");
  const delivered = await deliver(user.email, user.name, token, "invite");
  return { delivered, email: user.email };
}

/**
 * Spend a link and set the password.
 *
 * Every failure says the same thing. Distinguishing "expired" from "already
 * used" from "never existed" tells somebody feeding in guesses which of them
 * were close.
 */
export async function resetPassword(token: string, password: string): Promise<void> {
  const invalid = new AppError("UNAUTHENTICATED", "That link is no longer valid. Please request a new one.");

  const record = await PasswordToken.findOne({ tokenHash: hashToken(token) });
  if (!record) throw invalid;
  if (record.usedAt) throw invalid;
  if (record.expiresAt.getTime() < Date.now()) throw invalid;

  const user = await User.findById(record.userId);
  if (!user || user.status !== "active") throw invalid;

  // Spent before the password changes, and conditionally on still being
  // unspent, so two requests arriving together cannot both go through.
  const claimed = await PasswordToken.findOneAndUpdate(
    { _id: record._id, usedAt: { $exists: false } },
    { $set: { usedAt: new Date() } },
  );
  if (!claimed) throw invalid;

  user.passwordHash = await hashPassword(password);
  await user.save();

  // Whoever was signed in as this person is signed out. If the reset was
  // because the account was compromised, leaving those sessions alive would
  // defeat the point of it.
  await RefreshToken.deleteMany({ userId: user._id });

  logger.info({ userId: String(user._id) }, "Password set from a one-time link");
}
