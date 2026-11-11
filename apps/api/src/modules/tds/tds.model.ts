import { Schema, model, Types } from "mongoose";

/* TDS (Bangalore, 2026-11-11) — the organization's sections and rates, and what was paid to the government. */

const tdsSectionSchema = new Schema(
  { code: { type: String, required: true }, label: { type: String, required: true }, ratePct: { type: Number, required: true }, active: { type: Boolean, default: true } },
  { _id: false },
);

const tdsConfigSchema = new Schema(
  {
    organizationId: { type: Types.ObjectId, required: true, unique: true },
    enabled: { type: Boolean, default: true },
    sections: { type: [tdsSectionSchema], default: [] },
  },
  { timestamps: true },
);
export const TdsConfigModel = model("TdsConfig", tdsConfigSchema);

const tdsPaymentSchema = new Schema(
  {
    organizationId: { type: Types.ObjectId, required: true, index: true },
    /** The month it was deducted in, "YYYY-MM", and the section ("" — the month's TDS together). */
    period: { type: String, required: true },
    section: { type: String, default: "" },
    amountMinor: { type: Number, required: true },
    currency: { type: String, required: true },
    paidOn: { type: Date, required: true },
    bankAccountId: { type: Types.ObjectId, required: true },
    accountName: { type: String, default: "" },
    /** Its money-out line in that account. */
    bankTransactionId: { type: Types.ObjectId, default: null },
    challanNo: { type: String, default: "" },
    notes: { type: String, default: "" },
    createdById: { type: Types.ObjectId, default: null },
  },
  { timestamps: true },
);
tdsPaymentSchema.index({ organizationId: 1, period: 1 });
export const TdsPaymentModel = model("TdsPayment", tdsPaymentSchema);
