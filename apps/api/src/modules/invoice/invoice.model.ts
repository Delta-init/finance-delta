import { Schema, model, Types, type InferSchemaType } from "mongoose";

const taxRateSchema = new Schema(
  { code: { type: String, required: true }, rate: { type: Number, required: true }, amountMinor: { type: Number, required: true } },
  { _id: false },
);

const lineItemSchema = new Schema(
  {
    description: { type: String, required: true },
    quantity: { type: Number, required: true },
    unitPriceMinor: { type: Number, required: true },
    discountPct: { type: Number, default: 0 },
    taxes: { type: [taxRateSchema], default: [] },
    lineSubtotalMinor: { type: Number, required: true },
    discountMinor: { type: Number, required: true },
    taxableMinor: { type: Number, required: true },
    taxTotalMinor: { type: Number, required: true },
    lineTotalMinor: { type: Number, required: true },
    itemId: { type: String },
    warehouseId: { type: String },
  },
  { _id: false },
);

const progressSchema = new Schema(
  {
    contractDescription: { type: String, default: "" },
    contractValueMinor: { type: Number, default: 0 },
    stageName: { type: String, default: "" },
    stageNumber: { type: Number, default: 1 },
    pctOfContract: { type: Number, default: 0 },
  },
  { _id: false },
);

const recurringSchema = new Schema(
  {
    frequency: { type: String, enum: ["weekly", "monthly", "annually"], required: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date },
    nextRunAt: { type: Date, required: true },
    isActive: { type: Boolean, default: true },
  },
  { _id: false },
);

const paymentSubSchema = new Schema(
  {
    method: {
      type: String,
      enum: ["cash", "bank_transfer", "cheque", "card", "other"],
      required: true,
    },
    amountMinor: { type: Number, required: true, min: 0 },
    paidOn: { type: Date, required: true },
    reference: { type: String, default: "" },
    notes: { type: String, default: "" },
    accountName: { type: String, default: "" },
    proofUrl: { type: String, default: "" },
    proofKey: { type: String, default: "" },
  },
  { timestamps: true },
);

const brandingSnapshotSchema = new Schema(
  {
    logoUrl: { type: String, default: "" },
    primaryColor: { type: String, default: "" },
    footerText: { type: String, default: "" },
  },
  { _id: false },
);

const invoiceSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    invoiceNumber: { type: String, required: true },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", required: true },
    customerName: { type: String, required: true },
    salespersonId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    salespersonName: { type: String, required: true },
    reference: { type: String, default: "" },
    status: {
      type: String,
      enum: ["draft", "sent", "viewed", "paid", "partial", "overdue", "void"],
      default: "draft",
    },
    issueDate: { type: Date, required: true },
    dueDate: { type: Date, required: true },
    currency: { type: String, default: "AED" },
    lineItems: { type: [lineItemSchema], default: [] },
    subtotalMinor: { type: Number, default: 0 },
    discountTotalMinor: { type: Number, default: 0 },
    taxBreakdown: {
      type: [{ code: { type: String }, amountMinor: { type: Number } }],
      default: [],
      _id: false,
    },
    taxTotalMinor: { type: Number, default: 0 },
    totalMinor: { type: Number, default: 0 },
    amountPaidMinor: { type: Number, default: 0 },
    balanceMinor: { type: Number, default: 0 },
    notes: { type: String, default: "" },
    terms: { type: String, default: "" },
    tagIds: [{ type: Schema.Types.ObjectId, ref: "Tag" }],
    payments: { type: [paymentSubSchema], default: [] },
    branding: { type: brandingSnapshotSchema, default: () => ({}) },
    progress: { type: progressSchema, default: null },
    recurring: { type: recurringSchema, default: null },
    sourceQuoteId: { type: Schema.Types.ObjectId, ref: "Quotation" },
    journalEntryId: { type: Schema.Types.ObjectId },
    locale: { type: String, default: "en" },
    exchangeRate: { type: Number, default: 1 },
    lastEmailId: { type: String, default: "" },
    sentAt: Date,
    viewedAt: Date,
  },
  { timestamps: true },
);

invoiceSchema.index({ organizationId: 1, invoiceNumber: 1 }, { unique: true });
invoiceSchema.index({ organizationId: 1, status: 1, dueDate: 1 });
invoiceSchema.index({ organizationId: 1, salespersonId: 1 });
invoiceSchema.index({ organizationId: 1, customerId: 1 });

export type InvoiceDoc = InferSchemaType<typeof invoiceSchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
};
export const Invoice = model("Invoice", invoiceSchema);
