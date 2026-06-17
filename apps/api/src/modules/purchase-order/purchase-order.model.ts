import { Schema, model, Types, type InferSchemaType } from "mongoose";

const poLineSchema = new Schema(
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

const purchaseOrderSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    poNumber: { type: String, required: true },
    vendorId: { type: Schema.Types.ObjectId, ref: "Vendor", required: true },
    vendorName: { type: String, required: true },
    issueDate: { type: Date, required: true },
    expectedDate: { type: Date },
    status: {
      type: String,
      enum: ["draft", "sent", "received", "billed", "cancelled"],
      default: "draft",
    },
    currency: { type: String, default: "AED" },
    lineItems: { type: [poLineSchema], default: [] },
    subtotalMinor: { type: Number, default: 0 },
    taxTotalMinor: { type: Number, default: 0 },
    totalMinor: { type: Number, default: 0 },
    notes: { type: String, default: "" },
    sourceBillId: { type: Schema.Types.ObjectId, ref: "Bill" },
  },
  { timestamps: true },
);

purchaseOrderSchema.index({ organizationId: 1, poNumber: 1 }, { unique: true });

export type PurchaseOrderDoc = InferSchemaType<typeof purchaseOrderSchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
};
export const PurchaseOrder = model("PurchaseOrder", purchaseOrderSchema);
