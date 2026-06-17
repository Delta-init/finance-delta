import { Schema, model, Types, type InferSchemaType } from "mongoose";

const roleSchema = new Schema(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    key: { type: String, required: true }, // stable identifier within an org
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    permissions: { type: [String], default: [] },
    isSystem: { type: Boolean, default: false }, // system roles can't be deleted
  },
  { timestamps: true },
);

// Role keys are unique per organization.
roleSchema.index({ organizationId: 1, key: 1 }, { unique: true });

export type RoleDoc = InferSchemaType<typeof roleSchema> & { _id: Types.ObjectId };
export const Role = model("Role", roleSchema);
