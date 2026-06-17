import { Schema, model, Types, type InferSchemaType } from "mongoose";

const userSchema = new Schema(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    roleId: { type: Schema.Types.ObjectId, ref: "Role", required: true },
    status: {
      type: String,
      enum: ["active", "suspended"],
      default: "active",
    },
    lastLoginAt: { type: Date },
    tagIds: [{ type: Schema.Types.ObjectId, ref: "Tag" }],
  },
  { timestamps: true },
);

// Email is unique per organization.
userSchema.index({ organizationId: 1, email: 1 }, { unique: true });

export type UserDoc = InferSchemaType<typeof userSchema> & { _id: Types.ObjectId };
export const User = model("User", userSchema);
