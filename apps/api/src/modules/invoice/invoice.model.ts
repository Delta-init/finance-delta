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
    hsnSac: { type: String, default: "" },
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

const emiSubSchema = new Schema(
  {
    bank: { type: String, default: "" },
    tenureMonths: { type: Number, default: 0 },
    monthlyAmountMinor: { type: Number, default: 0 },
    interestPct: { type: Number, default: 0 },
    processingFeeMinor: { type: Number, default: 0 },
    transactionId: { type: String, default: "" },
  },
  { _id: false },
);

const paymentSubSchema = new Schema(
  {
    method: {
      type: String,
      // Kept in step with PAYMENT_METHODS in the shared schema; a method the
      // form offers but the model rejects fails only at save time.
      enum: ["cash", "bank_transfer", "cheque", "card", "easebuzz_emi", "tabby", "other"],
      required: true,
    },
    amountMinor: { type: Number, required: true, min: 0 },
    paidOn: { type: Date, required: true },
    reference: { type: String, default: "" },
    notes: { type: String, default: "" },
    accountName: { type: String, default: "" },
    chargesMinor: { type: Number, default: 0 },
    emi: { type: emiSubSchema, default: undefined },
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
    /**
     * What was enrolled in, when this invoice bills an enrolment.
     *
     * Absent on invoices accounts raise themselves, and its absence is what
     * exempts those from the approval gate — so adding this feature does not
     * put a backlog of existing drafts in front of an approver.
     */
    enrolment: {
      type: new Schema(
        {
          course: { type: String, required: true, trim: true },
          modeOfStudy: { type: String, enum: ["online", "offline", "hybrid"], required: true },
          language: { type: String, required: true, trim: true },
          meetingBy: { type: String, default: "" },
          /** What the counsellor says was collected. An approver records it. */
          declaredPaidMinor: { type: Number, default: 0 },
          declaredPaymentMethod: {
            type: String,
            enum: ["cash", "bank_transfer", "cheque", "card", "easebuzz_emi", "tabby", "other"],
          },
          approval: {
            type: String,
            enum: ["pending", "approved", "returned"],
            required: true,
            default: "pending",
          },
          approvedById: { type: Schema.Types.ObjectId, ref: "User" },
          approvedByName: { type: String },
          approvedAt: { type: Date },
          returnedReason: { type: String },
          submittedAt: { type: Date },
        },
        { _id: false },
      ),
      required: false,
    },
    reference: { type: String, default: "" },
    status: {
      type: String,
      enum: ["draft", "sent", "viewed", "paid", "partial", "overdue", "void"],
      default: "draft",
    },
    issueDate: { type: Date, required: true },
    dueDate: { type: Date, required: true },
    currency: { type: String, default: "AED" },
    taxInclusive: { type: Boolean, default: false },
    lineItems: { type: [lineItemSchema], default: [] },
    subtotalMinor: { type: Number, default: 0 },
    discountTotalMinor: { type: Number, default: 0 },
    taxBreakdown: {
      type: [{ code: { type: String }, amountMinor: { type: Number } }],
      default: [],
      _id: false,
    },
    taxTotalMinor: { type: Number, default: 0 },
    // Stored, not derived at render: a total that disagrees with what the
    // client was asked to pay is a reconciliation problem, not a display one.
    roundOffMinor: { type: Number, default: 0 },
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
