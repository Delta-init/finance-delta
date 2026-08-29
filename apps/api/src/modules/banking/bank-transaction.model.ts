import { Schema, model, Types, type InferSchemaType } from "mongoose";

const transactionMatchSchema = new Schema(
  {
    // "payroll" belongs here for the same reason the others do: a payroll
    // transfer appears on the bank statement and has to be matchable against
    // the run that caused it, or every payroll month leaves an unexplained
    // debit in reconciliation.
    type: { type: String, enum: ["invoice", "bill", "expense", "payroll"], required: true },
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
    /**
     * The bank's own reference for this transaction, where the statement
     * carries one (Federal Bank prints it as "Tran ID").
     *
     * A far better identity than date-plus-amount-plus-description: it is
     * unique per transaction, so two genuinely separate payments of the same
     * amount on the same day stop being indistinguishable.
     */
    externalId: { type: String },
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
// Enforced rather than merely checked: two imports racing each other would
// both pass a read-then-write test and both insert. Partial, because only
// imported rows carry a bank reference and nulls must not collide.
bankTransactionSchema.index(
  { organizationId: 1, accountId: 1, externalId: 1 },
  { unique: true, partialFilterExpression: { externalId: { $type: "string" } } },
);

export type BankTransactionDoc = InferSchemaType<typeof bankTransactionSchema> & {
  _id: Types.ObjectId;
};
export const BankTransaction = model<BankTransactionDoc>(
  "BankTransaction",
  bankTransactionSchema,
);
