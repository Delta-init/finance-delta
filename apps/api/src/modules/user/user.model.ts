import { Schema, model, Types, type InferSchemaType } from "mongoose";

const membershipSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    roleId:         { type: Schema.Types.ObjectId, ref: "Role", required: true },
    departmentId:   { type: Schema.Types.ObjectId, ref: "Department" },
    status:         { type: String, enum: ["active", "invited", "suspended"], default: "active" },
  },
  { _id: false },
);

const userSchema = new Schema(
  {
    name:         { type: String, required: true, trim: true },
    email:        { type: String, required: true, lowercase: true, trim: true, unique: true },
    passwordHash: { type: String, required: true },
    isSuperAdmin: { type: Boolean, default: false },
    status:       { type: String, enum: ["active", "suspended"], default: "active" },
    lastLoginAt:  { type: Date },
    /**
     * The organization this user was last working in.
     *
     * Logging in used to drop everybody into their first membership, so
     * somebody who works in one organization and occasionally visits another
     * was put back in the wrong one every morning. Remembered here rather than
     * in the browser because it should follow the person, not the machine they
     * happened to choose it on.
     */
    lastOrganizationId: { type: Schema.Types.ObjectId, ref: "Organization" },
    memberships:  { type: [membershipSchema], default: [] },
  },
  { timestamps: true },
);

// Fast lookup: all orgs a user belongs to, and all users in an org.
userSchema.index({ "memberships.organizationId": 1 });

export type MembershipDoc = InferSchemaType<typeof membershipSchema>;
export type UserDoc = InferSchemaType<typeof userSchema> & { _id: Types.ObjectId };
export const User = model("User", userSchema);
