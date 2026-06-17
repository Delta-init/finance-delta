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
  },
  { _id: false },
);

const expenseAttachmentSchema = new Schema(
  {
    name: { type: String, required: true },
    url: { type: String, required: true },
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
    category: {
      type: String,
      enum: ["salaries_wages", "commissions", "rent", "utilities", "travel", "marketing", "other"],
      required: true,
    },
    description: { type: String, required: true },
    expenseDate: { type: Date, required: true },
    amountMinor: { type: Number, required: true, default: 0 },
    taxPct: { type: Number, default: 0 },
    taxMinor: { type: Number, default: 0 },
    totalMinor: { type: Number, default: 0 },
    currency: { type: String, default: "AED" },
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
    costCentre: { type: String, default: "" },
    notes: { type: String, default: "" },
  },
  { timestamps: true },
);

expenseSchema.index({ organizationId: 1, expenseNumber: 1 }, { unique: true });
expenseSchema.index({ organizationId: 1, expenseDate: 1, status: 1 });
expenseSchema.index({ organizationId: 1, submittedById: 1 });
expenseSchema.index({ organizationId: 1, category: 1 });

export type ExpenseDoc = InferSchemaType<typeof expenseSchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
};
export const Expense = model("Expense", expenseSchema);
