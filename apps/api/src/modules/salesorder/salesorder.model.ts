import { Schema, model, Types, type InferSchemaType } from "mongoose";

const lineItemSchema = new Schema(
  {
    description: { type: String, required: true },
    quantity: { type: Number, required: true },
    unitPriceMinor: { type: Number, required: true },
    discountPct: { type: Number, default: 0 },
    taxPct: { type: Number, default: 0 },
    lineSubtotalMinor: { type: Number, required: true },
    discountMinor: { type: Number, required: true },
    taxMinor: { type: Number, required: true },
    lineTotalMinor: { type: Number, required: true },
  },
  { _id: false },
);

const salesOrderSchema = new Schema(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    orderNumber: { type: String, required: true },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", required: true },
    customerName: { type: String, required: true },
    sourceQuoteId: { type: Schema.Types.ObjectId, ref: "Quotation" },
    sourceQuoteNumber: { type: String },
    status: {
      type: String,
      enum: ["open", "fulfilled", "cancelled"],
      default: "open",
    },
    currency: { type: String, default: "AED" },
    lineItems: { type: [lineItemSchema], default: [] },
    subtotalMinor: { type: Number, default: 0 },
    discountTotalMinor: { type: Number, default: 0 },
    taxTotalMinor: { type: Number, default: 0 },
    totalMinor: { type: Number, default: 0 },
    tagIds: [{ type: Schema.Types.ObjectId, ref: "Tag" }],
  },
  { timestamps: true },
);

salesOrderSchema.index({ organizationId: 1, orderNumber: 1 }, { unique: true });

export type SalesOrderDoc = InferSchemaType<typeof salesOrderSchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
};
export const SalesOrder = model("SalesOrder", salesOrderSchema);
