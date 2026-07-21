import { Schema, model, Types, type InferSchemaType } from "mongoose";

const departmentSchema = new Schema(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
  },
  { timestamps: true },
);

departmentSchema.index({ organizationId: 1, name: 1 }, { unique: true });

export type DepartmentDoc = InferSchemaType<typeof departmentSchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
};
export const Department = model("Department", departmentSchema);
