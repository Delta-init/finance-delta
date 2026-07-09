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

const quotationSchema = new Schema(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    quoteNumber: { type: String, required: true },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", required: true },
    customerName: { type: String, required: true },
    status: {
      type: String,
      enum: ["draft", "sent", "accepted", "declined", "expired"],
      default: "draft",
    },
    issueDate: { type: Date, required: true },
    expiryDate: { type: Date, required: true },
    currency: { type: String, default: "AED" },
    lineItems: { type: [lineItemSchema], default: [] },
    subtotalMinor: { type: Number, default: 0 },
    discountTotalMinor: { type: Number, default: 0 },
    taxTotalMinor: { type: Number, default: 0 },
    taxBreakdown: { type: [taxBreakdownSchema], default: [] },
    totalMinor: { type: Number, default: 0 },
    notes: { type: String, default: "" },
    terms: { type: String, default: "" },
    tagIds: [{ type: Schema.Types.ObjectId, ref: "Tag" }],
    convertedTo: {
      salesOrderId: { type: Schema.Types.ObjectId, ref: "SalesOrder" },
      invoiceId: { type: Schema.Types.ObjectId },
    },
    sentAt: Date,
    acceptedAt: Date,
    declinedAt: Date,
  },
  { timestamps: true },
);

quotationSchema.index({ organizationId: 1, quoteNumber: 1 }, { unique: true });
quotationSchema.index({ organizationId: 1, status: 1, expiryDate: 1 });

export type QuotationDoc = InferSchemaType<typeof quotationSchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
};
export const Quotation = model("Quotation", quotationSchema);
