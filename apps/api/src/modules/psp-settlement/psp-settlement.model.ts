import { Schema, model, Types, type InferSchemaType } from "mongoose";

/**
 * A PSP settlement (the user, 2026-11-06): the provider paid some of the payments in its account on to a bank, less
 * its fee. Recorded as the money-in lines it covers, a transfer of what arrived from the PSP account to the bank, and
 * the fee — what was settled less what arrived — as an expense paid from the PSP account. Deleting it undoes all three.
 */
const pspSettlementSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true, index: true },
    number: { type: String, required: true },
    date: { type: Date, required: true },
    pspAccountId: { type: Schema.Types.ObjectId, required: true, index: true },
    pspAccountName: { type: String, required: true },
    bankAccountId: { type: Schema.Types.ObjectId, required: true },
    bankAccountName: { type: String, required: true },
    currency: { type: String, required: true },
    lineIds: { type: [Schema.Types.ObjectId], default: [] },
    grossMinor: { type: Number, required: true },
    receivedMinor: { type: Number, required: true },
    feeMinor: { type: Number, required: true },
    /** What the account's settings said the fee would be. */
    expectedFeeMinor: { type: Number, default: 0 },
    transferId: { type: Schema.Types.ObjectId, default: null },
    expenseId: { type: Schema.Types.ObjectId, default: null },
    expenseNumber: { type: String, default: "" },
    reference: { type: String, default: "" },
    notes: { type: String, default: "" },
    createdById: { type: Schema.Types.ObjectId, default: null },
    createdByName: { type: String, default: "" },
  },
  { timestamps: true },
);

pspSettlementSchema.index({ organizationId: 1, number: 1 }, { unique: true });

export type PspSettlementDoc = InferSchemaType<typeof pspSettlementSchema> & { _id: Types.ObjectId; createdAt: Date };
export const PspSettlement = model<PspSettlementDoc>("PspSettlement", pspSettlementSchema);
