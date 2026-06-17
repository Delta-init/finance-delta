import { Schema, model, Types, type InferSchemaType } from "mongoose";

const vcLineSchema = new Schema(
  {
    description: { type: String, required: true },
    quantity: { type: Number, required: true },
    unitPriceMinor: { type: Number, required: true },
    discountPct: { type: Number, default: 0 },
    taxPct: { type: Number, default: 0 },
    lineTotalMinor: { type: Number, required: true },
  },
  { _id: false },
);

const vendorCreditSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    creditNumber: { type: String, required: true },
    vendorId: { type: Schema.Types.ObjectId, ref: "Vendor", required: true },
    vendorName: { type: String, required: true },
    sourceBillId: { type: Schema.Types.ObjectId, ref: "Bill" },
    sourceBillNumber: { type: String },
    reason: { type: String, required: true },
    issueDate: { type: Date, required: true },
    status: { type: String, enum: ["draft", "issued", "applied", "voided"], default: "draft" },
    currency: { type: String, default: "AED" },
    lineItems: { type: [vcLineSchema], default: [] },
    subtotalMinor: { type: Number, default: 0 },
    taxTotalMinor: { type: Number, default: 0 },
    totalMinor: { type: Number, default: 0 },
    amountAppliedMinor: { type: Number, default: 0 },
    notes: { type: String, default: "" },
    issuedAt: { type: Date },
  },
  { timestamps: true },
);

vendorCreditSchema.index({ organizationId: 1, creditNumber: 1 }, { unique: true });

export type VendorCreditDoc = InferSchemaType<typeof vendorCreditSchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
};
export const VendorCredit = model("VendorCredit", vendorCreditSchema);
