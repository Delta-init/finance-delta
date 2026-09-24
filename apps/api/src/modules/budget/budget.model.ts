import { Schema, model, Types, type InferSchemaType } from "mongoose";

const allocationSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
  departmentId: { type: Schema.Types.ObjectId, ref: "Department", required: true, index: true },
  period: { type: String, required: true }, // YYYY-MM
  currency: { type: String, required: true, uppercase: true },
  allocatedMinor: { type: Number, required: true, min: 0 },
  note: { type: String, default: "" },
  updatedById: { type: Schema.Types.ObjectId, ref: "User", required: true },
  updatedByName: { type: String, required: true },
  changes: [{
    allocatedMinor: { type: Number, required: true },
    note: { type: String, default: "" },
    changedById: { type: Schema.Types.ObjectId, ref: "User", required: true },
    changedByName: { type: String, required: true },
    changedAt: { type: Date, required: true },
  }],
}, { timestamps: true });
allocationSchema.index({ organizationId: 1, departmentId: 1, period: 1, currency: 1 }, { unique: true });

export type BudgetAllocationDoc = InferSchemaType<typeof allocationSchema> & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };
export const BudgetAllocationModel = model("BudgetAllocation", allocationSchema);

const fundingRequestSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
  departmentId: { type: Schema.Types.ObjectId, ref: "Department", required: true, index: true },
  period: { type: String, required: true },
  currency: { type: String, required: true, uppercase: true },
  amountMinor: { type: Number, required: true, min: 1 },
  title: { type: String, required: true },
  purpose: { type: String, required: true },
  status: { type: String, enum: ["submitted", "approved", "rejected"], default: "submitted", index: true },
  requestedById: { type: Schema.Types.ObjectId, ref: "User", required: true },
  requestedByName: { type: String, required: true },
  reviewedById: { type: Schema.Types.ObjectId, ref: "User" },
  reviewedByName: { type: String },
  reviewedAt: { type: Date },
  reviewNote: { type: String, default: "" },
}, { timestamps: true });
fundingRequestSchema.index({ organizationId: 1, departmentId: 1, period: 1, status: 1 });
fundingRequestSchema.index({ organizationId: 1, status: 1, createdAt: -1 });

export type FundingRequestDoc = InferSchemaType<typeof fundingRequestSchema> & { _id: Types.ObjectId; createdAt: Date };
export const FundingRequestModel = model("FundingRequest", fundingRequestSchema);
