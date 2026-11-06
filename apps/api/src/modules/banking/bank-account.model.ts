import { Schema, model, Types, type InferSchemaType } from "mongoose";

const bankAccountSchema = new Schema(
  {
    organizationId: { type: Types.ObjectId, required: true, index: true },
    accountName: { type: String, required: true, trim: true },
    accountNumber: { type: String, default: "" },
    bankName: { type: String, default: "" },
    // Printed on an invoice so a client can actually pay it. Which of these is
    // needed depends on where the account is held, so none is required.
    branch: { type: String, default: "" },
    ifsc:   { type: String, default: "" },
    swift:  { type: String, default: "" },
    iban:   { type: String, default: "" },
    accountType: {
      type: String,
      enum: ["current", "savings", "petty_cash", "internal", "psp"],
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
    /** A PSP account's (2026-11-06): what it charges, where it settles to, from when (shared pspSettingsSchema). */
    psp: {
      type: new Schema(
        {
          provider: { type: String, default: "" },
          feePct: { type: Number, default: 0 },
          fixedFeeMinor: { type: Number, default: 0 },
          feeVatPct: { type: Number, default: 0 },
          settlementAccountId: { type: Types.ObjectId, required: true },
          settlementAccountName: { type: String, default: "" },
          settlementDays: { type: Number, default: 7 },
          startDate: { type: Date, required: true },
        },
        { _id: false },
      ),
      default: null,
    },
  },
  { timestamps: true },
);

bankAccountSchema.index({ organizationId: 1, accountName: 1 });
bankAccountSchema.index({ organizationId: 1, accountType: 1 });
bankAccountSchema.index({ organizationId: 1, isActive: 1 });

export type BankAccountDoc = InferSchemaType<typeof bankAccountSchema> & { _id: Types.ObjectId };
export const BankAccount = model<BankAccountDoc>("BankAccount", bankAccountSchema);
