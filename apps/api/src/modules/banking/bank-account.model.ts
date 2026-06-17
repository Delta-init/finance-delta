import { Schema, model, Types, type InferSchemaType } from "mongoose";

const bankAccountSchema = new Schema(
  {
    organizationId: { type: Types.ObjectId, required: true, index: true },
    accountName: { type: String, required: true, trim: true },
    accountNumber: { type: String, default: "" },
    bankName: { type: String, default: "" },
    accountType: {
      type: String,
      enum: ["checking", "savings", "petty_cash", "internal"],
      required: true,
    },
    currency: { type: String, required: true },
    currentBalanceMinor: { type: Number, required: true, default: 0 },
    openingBalanceMinor: { type: Number, required: true, default: 0 },
    openingDate: { type: Date, required: true },
    isActive: { type: Boolean, default: true },
    lastReconciledAt: { type: Date },
    lastReconciledStatementBalanceMinor: { type: Number },
    notes: { type: String, default: "" },
  },
  { timestamps: true },
);

bankAccountSchema.index({ organizationId: 1, accountName: 1 });
bankAccountSchema.index({ organizationId: 1, accountType: 1 });
bankAccountSchema.index({ organizationId: 1, isActive: 1 });

export type BankAccountDoc = InferSchemaType<typeof bankAccountSchema> & { _id: Types.ObjectId };
export const BankAccount = model<BankAccountDoc>("BankAccount", bankAccountSchema);
