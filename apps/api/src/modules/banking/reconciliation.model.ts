import { Schema, model, Types, type InferSchemaType } from "mongoose";

const reconciliationSessionSchema = new Schema(
  {
    organizationId: { type: Types.ObjectId, required: true, index: true },
    accountId: { type: Types.ObjectId, required: true, ref: "BankAccount" },
    accountName: { type: String, required: true },
    currency: { type: String, required: true },
    statementDate: { type: Date, required: true },
    /** The period the statement covers (2026-10-23): only its lines are listed. Absent on older sessions. */
    periodFrom: { type: Date },
    periodTo: { type: Date },
    statementBalanceMinor: { type: Number, required: true },
    openingBookBalanceMinor: { type: Number, required: true },
    closingBookBalanceMinor: { type: Number, required: true },
    differenceMinor: { type: Number, required: true },
    status: { type: String, enum: ["open", "completed"], default: "open" },
    reconciledTransactionIds: { type: [Types.ObjectId], default: [] },
    /** Line id → the statement's date for it, where it isn't the line's own (2026-10-23); written to the lines on completion. */
    statementDates: { type: Map, of: Date, default: {} },
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
    /**
     * The bank statement uploaded to check it against (the user, 2026-11-07): the file, kept as evidence; its lines,
     * so "Check again" needs no new upload; the pairs recorded since (a line with the bank charge recorded for its
     * difference); and the last check, as the page shows it.
     */
    statementFile: {
      type: new Schema({ name: String, key: String, url: String, uploadedAt: Date }, { _id: false }),
      default: undefined,
    },
    statementFileName: { type: String, default: "" },
    statementLines: {
      type: [new Schema({
        date: String, description: String, reference: String, amountMinor: Number, balanceMinor: { type: Number, default: null },
      }, { _id: false })],
      default: undefined,
    },
    statementPairs: {
      type: [new Schema({ index: Number, bookLineIds: [Types.ObjectId] }, { _id: false })],
      default: undefined,
    },
    statementCheck: { type: Schema.Types.Mixed, default: undefined },
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
