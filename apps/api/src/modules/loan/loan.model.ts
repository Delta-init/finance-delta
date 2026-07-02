import { Schema, model, Types, type InferSchemaType } from "mongoose";

const loanSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    loanNumber: { type: String, required: true },
    type: { type: String, enum: ["taken", "given"], required: true },
    counterpartyName: { type: String, required: true },
    counterpartyType: { type: String, enum: ["customer", "vendor", "other"], default: "other" },
    counterpartyId: { type: Schema.Types.ObjectId },
    principalMinor: { type: Number, required: true },
    interestRate: { type: Number, required: true, default: 0 },
    interestType: { type: String, enum: ["simple", "compound"], default: "simple" },
    startDate: { type: String, required: true },
    dueDate: { type: String },
    repaymentFrequency: {
      type: String,
      enum: ["monthly", "quarterly", "annually", "bullet", "none"],
      default: "monthly",
    },
    status: { type: String, enum: ["active", "closed", "defaulted"], default: "active" },
    notes: { type: String, default: "" },
    createdById: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

loanSchema.index({ organizationId: 1, status: 1 });
loanSchema.index({ organizationId: 1, loanNumber: 1 }, { unique: true });

export type LoanDoc = InferSchemaType<typeof loanSchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
};

export const Loan = model("Loan", loanSchema);
