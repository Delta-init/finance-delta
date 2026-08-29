import { Schema, model, type InferSchemaType, type Types } from "mongoose";

/**
 * A one-time link that lets somebody set a password.
 *
 * Two purposes, one mechanism. An invite is the first password on an account
 * that has never had a usable one — the payroll logins are created with a
 * password derived from bytes that are thrown away, so there is nothing to
 * type and no way in without one of these. A reset is the same thing for
 * somebody who has forgotten theirs.
 *
 * The token is never stored. Only its SHA-256 is, so a leaked database does
 * not hand over working links — the same treatment refresh tokens already get,
 * and appropriate here for the same reason: the token is high-entropy random
 * rather than a human-chosen password, so a fast hash is the right one.
 */
const passwordTokenSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    tokenHash: { type: String, required: true, index: true },
    purpose: { type: String, enum: ["invite", "reset"], required: true },
    expiresAt: { type: Date, required: true },
    /**
     * When it was spent. Present means spent: a link that works twice is a link
     * that still works after it has been forwarded, printed, or left in an
     * inbox somebody else can read.
     */
    usedAt: { type: Date },
  },
  { timestamps: true },
);

// Mongo removes them once expired. Kept a while past expiry so a spent token
// can still be told apart from one that never existed while the link is fresh
// in somebody's inbox; after that the distinction stops mattering.
passwordTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 });

export type PasswordTokenDoc = InferSchemaType<typeof passwordTokenSchema> & {
  _id: Types.ObjectId;
};
export const PasswordToken = model("PasswordToken", passwordTokenSchema);
