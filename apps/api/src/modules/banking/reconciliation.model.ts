import { Schema, model, Types, type InferSchemaType } from "mongoose";

const reconciliationSessionSchema = new Schema(
  {
    organizationId: { type: Types.ObjectId, required: true, index: true },
    accountId: { type: Types.ObjectId, required: true, ref: "BankAccount" },
    accountName: { type: String, required: true },
    currency: { type: String, required: true },
    statementDate: { type: Date, required: true },
    statementBalanceMinor: { type: Number, required: true },
    openingBookBalanceMinor: { type: Number, required: true },
    closingBookBalanceMinor: { type: Number, required: true },
    differenceMinor: { type: Number, required: true },
    status: { type: String, enum: ["open", "completed"], default: "open" },
    reconciledTransactionIds: { type: [Types.ObjectId], default: [] },
    completedAt: { type: Date },
    completedByName: { type: String },
    /**
     * The entry a cash count posted to make the book agree with what was
     * counted, where there was a difference.
     *
     * Held so undoing the count can take it back out. Without it the entry
     * would be indistinguishable from one somebody typed, and undoing would
     * leave the book adjusted for a count that no longer exists.
     */
    adjustmentTransactionId: { type: String },
    notes: { type: String, default: "" },
  },
  { timestamps: true },
);

reconciliationSessionSchema.index({ organizationId: 1, accountId: 1, status: 1 });
reconciliationSessionSchema.index({ organizationId: 1, accountId: 1, statementDate: -1 });

export type ReconciliationSessionDoc = InferSchemaType<typeof reconciliationSessionSchema> & {
  _id: Types.ObjectId;
};
export const ReconciliationSession = model<ReconciliationSessionDoc>(
  "ReconciliationSession",
  reconciliationSessionSchema,
);
