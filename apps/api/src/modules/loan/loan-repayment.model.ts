import { Schema, model, Types, type InferSchemaType } from "mongoose";

const loanRepaymentSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    loanId: { type: Schema.Types.ObjectId, ref: "Loan", required: true, index: true },
    paidOn: { type: String, required: true },
    principalMinor: { type: Number, required: true, default: 0 },
    interestMinor: { type: Number, required: true, default: 0 },
    notes: { type: String, default: "" },
    createdById: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

export type LoanRepaymentDoc = InferSchemaType<typeof loanRepaymentSchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
};

export const LoanRepayment = model("LoanRepayment", loanRepaymentSchema);
