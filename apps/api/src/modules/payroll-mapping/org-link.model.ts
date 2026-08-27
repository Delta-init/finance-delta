import { Schema, model, Types, type InferSchemaType } from "mongoose";

/**
 * Which HRMS organization feeds which finance organization.
 *
 * The relationship is many-to-one on purpose: several HRMS entities can run
 * their payroll through one finance book (e.g. the training company paying out
 * of Delta HQ). The unique index is on `hrmsOrgId` alone, which is what enforces
 * the "many" side — one HRMS org has exactly one destination, and a second link
 * for it is rejected rather than silently splitting a payroll in two.
 */
const payrollOrgLinkSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },

    hrmsOrgId: { type: String, required: true },
    hrmsOrgCode: { type: String, default: "" },
    hrmsOrgName: { type: String, default: "" },

    /**
     * The currency HRMS runs this payroll in, recorded at link time.
     *
     * Kept so that a mismatch against the finance organization's base currency
     * is caught here, once, rather than discovered as a wrong number on a
     * payslip. Phase 0 records it; converting it is a later phase's problem.
     */
    hrmsCurrency: { type: String, default: "AED" },

    isActive: { type: Boolean, default: true },
    linkedByUserId: { type: Schema.Types.ObjectId, ref: "User" },
    linkedByName: { type: String, default: "" },
    lastSyncedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

payrollOrgLinkSchema.index({ hrmsOrgId: 1 }, { unique: true });

export type PayrollOrgLinkDoc = InferSchemaType<typeof payrollOrgLinkSchema> & {
  _id: Types.ObjectId;
};
export const PayrollOrgLink = model("PayrollOrgLink", payrollOrgLinkSchema);
