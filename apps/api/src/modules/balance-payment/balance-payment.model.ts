import { Schema, model, type InferSchemaType, type Types } from "mongoose";
import { PAYMENT_METHODS } from "@delta/shared";

/**
 * The next payment of a part-paid enrolment, recorded in the sales CRM that
 * closed it (the user, 2026-10-13), with its receipt, waiting for accounts.
 * Approved, it is recorded on the invoice (`paymentId`) through recordPayment,
 * like accounts' own; the CRM reads its state back with the enrolment's
 * status. Unique on the CRM's own id, so a retry is the same payment.
 */
const balancePaymentSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    /** The CRM's intake source (crm, draw-crm, banglore-crm) and its id for this payment. */
    source: { type: String, required: true },
    externalId: { type: String, required: true },
    invoiceId: { type: Schema.Types.ObjectId, ref: "Invoice", required: true, index: true },
    invoiceNumber: { type: String, default: "" },
    customerName: { type: String, default: "" },
    course: { type: String, default: "" },
    amountMinor: { type: Number, required: true, min: 1 },
    currency: { type: String, required: true },
    method: { type: String, enum: [...PAYMENT_METHODS], required: true },
    paidOn: { type: String, required: true },
    receipt: {
      name: { type: String, default: "Receipt" },
      url: { type: String, required: true },
      key: { type: String, default: "" },
      mimeType: { type: String },
    },
    note: { type: String, default: "" },
    recordedBy: { name: { type: String, default: "" }, email: { type: String, default: "" } },
    status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending", index: true },
    decision: {
      type: new Schema({
        decidedById: { type: Schema.Types.ObjectId, ref: "User" },
        decidedByName: { type: String, default: "" },
        decidedAt: { type: Date },
        reason: { type: String },
        reference: { type: String },
        note: { type: String },
      }, { _id: false }),
      default: undefined,
    },
    /** Recorded on the invoice: that payment, and its receipt number. */
    paymentId: { type: String },
    receiptNumber: { type: String },
  },
  { timestamps: true },
);

balancePaymentSchema.index({ organizationId: 1, source: 1, externalId: 1 }, { unique: true });

export type BalancePaymentDoc = InferSchemaType<typeof balancePaymentSchema> & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };
export const BalancePaymentModel = model("BalancePayment", balancePaymentSchema);
