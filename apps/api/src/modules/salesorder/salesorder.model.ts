import { Schema, model, Types, type InferSchemaType } from "mongoose";

const lineTaxSchema = new Schema(
  {
    code: { type: String, required: true },
    rate: { type: Number, required: true },
  },
  { _id: false },
);

const lineItemSchema = new Schema(
  {
    description: { type: String, required: true },
    quantity: { type: Number, required: true },
    unitPriceMinor: { type: Number, required: true },
    discountPct: { type: Number, default: 0 },
    taxPct: { type: Number, default: 0 },
    taxes: { type: [lineTaxSchema], default: [] },
    itemId: { type: String },
    lineSubtotalMinor: { type: Number, required: true },
    discountMinor: { type: Number, required: true },
    taxMinor: { type: Number, required: true },
    lineTotalMinor: { type: Number, required: true },
  },
  { _id: false },
);

const taxBreakdownSchema = new Schema(
  {
    code: { type: String, required: true },
    amountMinor: { type: Number, required: true },
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
    /**
     * Carried over from the quotation this order came from.
     *
     * Without it a tax-inclusive quote was re-priced as exclusive on
     * conversion: a line quoted at 105.00 became an order for 110.25, because
     * the tax already inside the price was added a second time.
     */
    taxInclusive: { type: Boolean, default: false },
    lineItems: { type: [lineItemSchema], default: [] },
    subtotalMinor: { type: Number, default: 0 },
    discountTotalMinor: { type: Number, default: 0 },
    taxTotalMinor: { type: Number, default: 0 },
    taxBreakdown: { type: [taxBreakdownSchema], default: [] },
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
