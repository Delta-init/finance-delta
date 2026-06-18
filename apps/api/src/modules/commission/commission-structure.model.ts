import { Schema, model, Types, type InferSchemaType } from "mongoose";

const tierSchema = new Schema(
  { upToMinor: { type: Number, default: null }, percentage: { type: Number, required: true } },
  { _id: false },
);

const commissionStructureSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    salespersonId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    salespersonName: { type: String, required: true },
    type: { type: String, enum: ["flat", "percentage", "tiered"], required: true },
    flatAmountMinor: { type: Number, default: 0 },
    percentage: { type: Number, default: 0 },
    tiers: { type: [tierSchema], default: [] },
    basis: { type: String, enum: ["invoice_raised", "payment_received"], required: true },
    isLocked: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    effectiveFrom: { type: Date, required: true },
    effectiveTo: { type: Date },
    notes: { type: String, default: "" },
    lockedById: { type: Schema.Types.ObjectId, ref: "User" },
    lockedByName: { type: String, default: "" },
    lockedAt: { type: Date },
    createdById: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

commissionStructureSchema.index({ organizationId: 1, salespersonId: 1 });

export type CommissionStructureDoc = InferSchemaType<typeof commissionStructureSchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
};

export const CommissionStructure = model("CommissionStructure", commissionStructureSchema);
