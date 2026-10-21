import { Schema, model, Types } from "mongoose";

/**
 * A sales CRM's commission for one person and month, approved by a manager and then paid (2026-10-21). Only made
 * when a manager approves — "earned" is the CRM's figure, read live through Root. One per CRM, month and person
 * across all of finance (`key`, unique), so it can never be approved or paid twice, whichever organization pays it.
 */
const payoutSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    crm: { type: String, required: true },
    crmName: { type: String, default: "" },
    month: { type: String, required: true },
    userId: { type: String, required: true },
    personName: { type: String, default: "" },
    roles: { type: [String], default: [] },
    currency: { type: String, default: "AED" },
    /** What the manager approved — My Pay's commission payable then (2026-10-21), frozen. */
    amountMinor: { type: Number, required: true, min: 0 },
    /** The commission earned it is a share of, the slab level's percent and its name — as they stood then. */
    earnedMinor: { type: Number },
    percent: { type: Number },
    level: { type: String },
    sales: { type: Number, default: 0 },
    saleIds: { type: [String], default: [] },
    state: { type: String, enum: ["approved", "paid"], required: true },
    approvedById: { type: Schema.Types.ObjectId, ref: "User", required: true },
    approvedByName: { type: String, default: "" },
    approvedAt: { type: Date, required: true },
    approvalNote: { type: String, default: "" },
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
  },
  { timestamps: true },
);

payoutSchema.index({ month: 1, crm: 1 });

export const CrmCommissionPayout = model("CrmCommissionPayout", payoutSchema);
export type CrmCommissionPayoutDoc = InstanceType<typeof CrmCommissionPayout> & { _id: Types.ObjectId };
