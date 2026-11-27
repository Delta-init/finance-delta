import { Schema, model, Types, type InferSchemaType } from "mongoose";

const creditLineSchema = new Schema(
  {
    description: { type: String, required: true },
    quantity: { type: Number, required: true },
    unitPriceMinor: { type: Number, required: true },
    discountPct: { type: Number, default: 0 },
    taxPct: { type: Number, default: 0 },
    lineTotalMinor: { type: Number, required: true },
  },
  { _id: false },
);

const creditNoteSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    creditNoteNumber: { type: String, required: true },
    invoiceId: { type: Schema.Types.ObjectId, ref: "Invoice", required: true },
    invoiceNumber: { type: String, required: true },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", required: true },
    customerName: { type: String, required: true },
    reason: { type: String, required: true },
    status: { type: String, enum: ["draft", "issued", "applied", "voided"], default: "draft" },
    lineItems: { type: [creditLineSchema], default: [] },
    subtotalMinor: { type: Number, default: 0 },
    taxTotalMinor: { type: Number, default: 0 },
    discountTotalMinor: { type: Number, default: 0 },
    totalMinor: { type: Number, default: 0 },
    amountAppliedMinor: { type: Number, default: 0 },
    /**
     * Where each part of the credit went (2026-11-27, audit F05): the invoice and the amount, one entry per apply. A
     * note applied before this has none — its whole amountAppliedMinor is on its own invoice (creditApplied below).
     */
    applications: {
      type: [new Schema({ invoiceId: { type: Schema.Types.ObjectId, ref: "Invoice", required: true }, amountMinor: { type: Number, required: true }, appliedAt: { type: Date, default: Date.now } }, { _id: false })],
      default: undefined,
    },
    currency: { type: String, default: "AED" },
    issuedAt: { type: Date },
  },
  { timestamps: true },
);

creditNoteSchema.index({ organizationId: 1, creditNoteNumber: 1 }, { unique: true });

export type CreditNoteDoc = InferSchemaType<typeof creditNoteSchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
};
export const CreditNote = model("CreditNote", creditNoteSchema);
