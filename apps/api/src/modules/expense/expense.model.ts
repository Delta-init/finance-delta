import { Schema, model, Types, type InferSchemaType } from "mongoose";

const expenseMileageSchema = new Schema(
  {
    distanceKm: { type: Number, required: true },
    ratePerKmMinor: { type: Number, required: true },
    totalMinor: { type: Number, required: true },
  },
  { _id: false },
);

const expenseRecurrenceSchema = new Schema(
  {
    frequency: {
      type: String,
      enum: ["weekly", "monthly", "quarterly", "yearly"],
      required: true,
    },
    nextDate: { type: Date, required: true },
    endDate: { type: Date },
    isActive: { type: Boolean, default: true },
  },
  { _id: false },
);

const expenseAttachmentSchema = new Schema(
  {
    name: { type: String, required: true },
    url: { type: String, required: true },
    /**
     * Where it lives in object storage.
     *
     * Needed to delete the object when the attachment is removed — without it
     * the row goes and the file stays, and nothing afterwards knows it is
     * there. Absent on rows that predate this.
     */
    key: { type: String },
    size: { type: Number },
    mimeType: { type: String },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

/**
 * Where an expense came from, when it was not typed in here.
 *
 * Set on a purchase request from HRMS approved on the Procurement page. `key`
 * names the request and the round it is on — one finance rejects can be
 * revised and sent back, and that is a new decision — and is unique, so a
 * retry or a second approver finds the expense a first attempt made rather
 * than making another. `deliveredAt` is when HRMS took the answer: without
 * it, the expense exists and HR has not been told yet.
 */
const expenseSourceSchema = new Schema(
  {
    kind: { type: String, enum: ["hrms_procurement"], required: true },
    key: { type: String, required: true },
    hrmsOrgId: { type: String, required: true },
    requestId: { type: String, required: true },
    round: { type: Number, default: 0 },
    deliveredAt: { type: Date },
  },
  { _id: false },
);

const expenseSchema = new Schema(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    expenseNumber: { type: String, required: true },
    // Slug of a managed expense category (see expense-category module).
    category: { type: String, required: true },
    // Denormalized display name, kept in sync on category rename.
    categoryName: { type: String, default: "" },
    description: { type: String, required: true },
    expenseDate: { type: Date, required: true },
    amountMinor: { type: Number, required: true, default: 0 },
    taxPct: { type: Number, default: 0 },
    taxMinor: { type: Number, default: 0 },
    totalMinor: { type: Number, default: 0 },
    currency: { type: String, default: "AED" },
    // How the claimed figure was read, kept so editing shows it back the way it
    // was typed rather than silently switching to the other reading.
    taxInclusive: { type: Boolean, default: false },
    paymentAccount: { type: String, default: "" },
    paymentMethod: {
      type: String,
      enum: ["bank_transfer", "cash", "cheque", "card", "online"],
    },
    reference: { type: String, default: "" },
    submittedById: { type: Schema.Types.ObjectId, ref: "User", required: true },
    submittedByName: { type: String, required: true },
    status: {
      type: String,
      enum: ["draft", "submitted", "approved", "rejected", "voided"],
      default: "draft",
    },
    /**
     * When the claim should be settled by, and when it was.
     *
     * Two facts, not three: "overdue" is a fact about today rather than about
     * the expense, so storing it would be wrong by the next morning. It is
     * derived from these on read.
     */
    dueDate: { type: Date },
    paidOn: { type: Date },
    approvedById: { type: Schema.Types.ObjectId, ref: "User" },
    approvedByName: { type: String },
    approvedAt: { type: Date },
    rejectedReason: { type: String },
    isRecurring: { type: Boolean, default: false },
    recurrence: { type: expenseRecurrenceSchema },
    parentExpenseId: { type: Schema.Types.ObjectId, ref: "Expense" },
    mileage: { type: expenseMileageSchema },
    attachments: { type: [expenseAttachmentSchema], default: [] },
    projectName: { type: String, default: "" },
    departmentId: { type: Schema.Types.ObjectId, ref: "Department" },
    /**
     * The free-text cost centre this replaced.
     *
     * Kept for the claims that already carry one. It was a different spelling
     * of the same department on every claim, which is why nothing could ever be
     * grouped on it — but that is not a reason to throw away what was typed.
     */
    costCentre: { type: String, default: "" },
    notes: { type: String, default: "" },
    source: { type: expenseSourceSchema },
  },
  { timestamps: true },
);

expenseSchema.index({ organizationId: 1, expenseNumber: 1 }, { unique: true });
expenseSchema.index({ organizationId: 1, expenseDate: 1, status: 1 });
expenseSchema.index({ organizationId: 1, submittedById: 1 });
expenseSchema.index({ organizationId: 1, category: 1 });
// Listing the unpaid and the overdue, which is what the payment filter asks for.
expenseSchema.index({ organizationId: 1, paidOn: 1, dueDate: 1 });
// One expense per purchase request and round, however many times it is approved.
expenseSchema.index({ "source.key": 1 }, { unique: true, partialFilterExpression: { "source.key": { $exists: true } } });

export type ExpenseDoc = InferSchemaType<typeof expenseSchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
};
export const Expense = model("Expense", expenseSchema);
