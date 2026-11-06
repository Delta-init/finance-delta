import { Schema, model, Types } from "mongoose";

/**
 * The CS Portal's commission for one CS and period, approved by a manager and then paid (2026-11-03) — like a CRM's
 * (crm-commission-payout.model.ts). Only made when a manager approves, which also releases the credits in the CS
 * Portal (its Finance step); "earned" is the CS Portal's figure, read live. One per kind, period and CS across all of
 * finance (`key`, unique), so it can never be approved or paid twice, whichever organization pays it.
 */
const payoutSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    kind: { type: String, enum: ["bonus", "deposit"], required: true },
    /** YYYY-MM for bonus, YYYY-Qn for deposit. */
    period: { type: String, required: true },
    /** The period's last month, YYYY-MM — what a payroll run's month is compared with. */
    lastMonth: { type: String, required: true },
    recipientId: { type: String, required: true },
    personName: { type: String, default: "" },
    /** Their CS Portal login's email — how payroll finds their payslip. */
    email: { type: String, default: "" },
    location: { type: String, enum: ["dubai", "bangalore"], default: "dubai" },
    /** AED, or INR for a Bangalore team's CS. */
    currency: { type: String, default: "AED" },
    /** What the manager approved, in `currency` — the CS Portal's USD at its fixed rate then, frozen. */
    amountMinor: { type: Number, required: true, min: 0 },
    amountUsd: { type: Number, required: true, min: 0 },
    creditIds: { type: [String], default: [] },
    state: { type: String, enum: ["approved", "paid"], required: true },
    approvedById: { type: Schema.Types.ObjectId, ref: "User", required: true },
    approvedByName: { type: String, default: "" },
    approvedAt: { type: Date, required: true },
    approvalNote: { type: String, default: "" },
    /** Approved before the CS Portal's broker admin and academic head, through Record payment (2026-11-06). */
    beforePortal: { type: Boolean, default: false },
    paidById: { type: Schema.Types.ObjectId, ref: "User" },
    paidByName: { type: String },
    paidAt: { type: Date },
    paidOn: { type: Date },
    paymentMethod: { type: String },
    reference: { type: String },
    expenseId: { type: Schema.Types.ObjectId, ref: "Expense" },
    expenseNumber: { type: String },
    receipt: {
      type: new Schema({ name: String, key: String, url: String, size: Number, mimeType: String }, { _id: false }),
      default: null,
    },
    /** Pulled onto a payroll run, like the CRMs' commission: paid with the run's transfer; while set, not here. */
    payrollRunId: { type: Schema.Types.ObjectId, ref: "PayrollRun", default: null },
    payrollRunNumber: { type: String, default: "" },
  },
  { timestamps: true },
);

payoutSchema.index({ kind: 1, period: 1 });

export const CsCommissionPayout = model("CsCommissionPayout", payoutSchema);
export type CsCommissionPayoutDoc = InstanceType<typeof CsCommissionPayout> & { _id: Types.ObjectId };
