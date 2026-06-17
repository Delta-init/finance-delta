import { Schema, model, Types, type InferSchemaType } from "mongoose";

const billLineSchema = new Schema(
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

const billPaymentSchema = new Schema(
  {
    method: { type: String, required: true },
    amountMinor: { type: Number, required: true },
    paidOn: { type: Date, required: true },
    reference: { type: String, default: "" },
    accountName: { type: String, default: "" },
    notes: { type: String, default: "" },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true },
);

const billSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    billNumber: { type: String, required: true },
    vendorId: { type: Schema.Types.ObjectId, ref: "Vendor", required: true },
    vendorName: { type: String, required: true },
    sourcePOId: { type: Schema.Types.ObjectId, ref: "PurchaseOrder" },
    sourcePONumber: { type: String },
    billDate: { type: Date, required: true },
    dueDate: { type: Date, required: true },
    status: {
      type: String,
      enum: ["draft", "pending_approval", "approved", "partially_paid", "paid", "overdue", "voided"],
      default: "draft",
    },
    approvalStatus: {
      type: String,
      enum: ["not_required", "pending", "approved", "rejected"],
      default: "not_required",
    },
    currency: { type: String, default: "AED" },
    lineItems: { type: [billLineSchema], default: [] },
    subtotalMinor: { type: Number, default: 0 },
    taxTotalMinor: { type: Number, default: 0 },
    totalMinor: { type: Number, default: 0 },
    amountPaidMinor: { type: Number, default: 0 },
    balanceMinor: { type: Number, default: 0 },
    payments: { type: [billPaymentSchema], default: [] },
    notes: { type: String, default: "" },
    paymentTerms: { type: String, default: "" },
  },
  { timestamps: true },
);

billSchema.index({ organizationId: 1, billNumber: 1 }, { unique: true });
billSchema.index({ organizationId: 1, vendorId: 1 });
billSchema.index({ organizationId: 1, dueDate: 1, status: 1 });

export type BillDoc = InferSchemaType<typeof billSchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
};
export const Bill = model("Bill", billSchema);
