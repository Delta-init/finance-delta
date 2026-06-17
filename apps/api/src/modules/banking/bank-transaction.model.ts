import { Schema, model, Types, type InferSchemaType } from "mongoose";

const transactionMatchSchema = new Schema(
  {
    type: { type: String, enum: ["invoice", "bill", "expense"], required: true },
    referenceId: { type: String, required: true },
    referenceNumber: { type: String, required: true },
    amountMinor: { type: Number, required: true },
  },
  { _id: false },
);

const bankTransactionSchema = new Schema(
  {
    organizationId: { type: Types.ObjectId, required: true, index: true },
    accountId: { type: Types.ObjectId, required: true, ref: "BankAccount" },
    accountName: { type: String, required: true },
    currency: { type: String, required: true },
    date: { type: Date, required: true },
    description: { type: String, required: true },
    reference: { type: String, default: "" },
    amountMinor: { type: Number, required: true },
    type: { type: String, enum: ["credit", "debit"], required: true },
    runningBalanceMinor: { type: Number, required: true },
    source: { type: String, enum: ["manual", "import"], required: true, default: "manual" },
    importBatchId: { type: String },
    status: {
      type: String,
      enum: ["unmatched", "matched", "excluded", "duplicate"],
      default: "unmatched",
    },
    matches: { type: [transactionMatchSchema], default: [] },
    isReconciled: { type: Boolean, default: false },
    reconciledSessionId: { type: String },
    notes: { type: String, default: "" },
  },
  { timestamps: true },
);

bankTransactionSchema.index({ organizationId: 1, accountId: 1, date: -1 });
bankTransactionSchema.index({ organizationId: 1, accountId: 1, status: 1 });
bankTransactionSchema.index({ organizationId: 1, accountId: 1, isReconciled: 1 });
bankTransactionSchema.index({ organizationId: 1, importBatchId: 1 });

export type BankTransactionDoc = InferSchemaType<typeof bankTransactionSchema> & {
  _id: Types.ObjectId;
};
export const BankTransaction = model<BankTransactionDoc>(
  "BankTransaction",
  bankTransactionSchema,
);
