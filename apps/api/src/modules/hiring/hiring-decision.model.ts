import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * Finance's decision on an HRMS hiring request (2026-10-15).
 *
 * HRMS keeps the request; this keeps what finance decided, who and when, and
 * enough of the request to show it on Approvals afterwards — HRMS only lists
 * the ones still waiting. One per request: deciding again resends the same
 * answer rather than making a second. `deliveredAt` is when HRMS took it; a
 * decision HRMS did not take is resent by deciding the same way again.
 */
const hiringDecisionSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    hrmsOrgId: { type: String, required: true },
    hrmsOrgName: { type: String, default: "" },
    requisitionId: { type: String, required: true },
    decision: { type: String, enum: ["approved", "rejected"], required: true },
    note: { type: String, default: "" },
    decidedById: { type: Schema.Types.ObjectId, ref: "User" },
    decidedByName: { type: String, default: "" },
    decidedAt: { type: Date, required: true },
    deliveredAt: { type: Date },
    request: {
      title: String,
      // `type` is Mongoose's own word for a field's type: spelled out, or the whole object reads as a string.
      type: { type: String },
      headcount: Number,
      salaryMin: Number,
      salaryMax: Number,
      currency: String,
      department: String,
      raisedBy: String,
      hrApprovedAt: Date,
    },
  },
  { timestamps: true },
);
hiringDecisionSchema.index({ hrmsOrgId: 1, requisitionId: 1 }, { unique: true });
hiringDecisionSchema.index({ organizationId: 1, decidedAt: -1 });

export type HiringDecisionDoc = InferSchemaType<typeof hiringDecisionSchema>;
export const HiringDecision = model("HiringDecision", hiringDecisionSchema);
