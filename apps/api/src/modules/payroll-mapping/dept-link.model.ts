import { Schema, model, Types, type InferSchemaType } from "mongoose";

/**
 * Which HRMS department corresponds to which finance department.
 *
 * Many-to-one for the same reason as the org link: if two HRMS organizations
 * both have a "Sales" department and both pay out of Delta HQ, they map to the
 * one finance Sales department. Finance's own
 * `(organizationId, name)` unique index makes that the only possible answer,
 * so the mapping is stored here rather than as a field on Department.
 */
const payrollDeptLinkSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },

    hrmsOrgId: { type: String, required: true },
    hrmsDepartmentId: { type: String, required: true },
    hrmsDepartmentName: { type: String, default: "" },

    departmentId: { type: Schema.Types.ObjectId, ref: "Department", required: true },

    isActive: { type: Boolean, default: true },
    linkedByUserId: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

// One destination per HRMS department.
payrollDeptLinkSchema.index({ hrmsOrgId: 1, hrmsDepartmentId: 1 }, { unique: true });
// The reverse lookup: everything feeding one finance department.
payrollDeptLinkSchema.index({ organizationId: 1, departmentId: 1 });

export type PayrollDeptLinkDoc = InferSchemaType<typeof payrollDeptLinkSchema> & {
  _id: Types.ObjectId;
};
export const PayrollDeptLink = model("PayrollDeptLink", payrollDeptLinkSchema);
