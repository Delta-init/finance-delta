import { Schema, model, Types, type InferSchemaType } from "mongoose";

const commissionRecordSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    structureId: { type: Schema.Types.ObjectId, ref: "CommissionStructure", required: true },
    salespersonId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    salespersonName: { type: String, required: true },
    invoiceId: { type: Schema.Types.ObjectId, ref: "Invoice", required: true },
    invoiceNumber: { type: String, required: true },
    invoiceTotalMinor: { type: Number, required: true },
    commissionMinor: { type: Number, required: true },
    basis: { type: String, enum: ["invoice_raised", "payment_received"], required: true },
    status: { type: String, enum: ["earned", "paid", "cancelled"], default: "earned" },
    calculatedAt: { type: Date, default: Date.now },
    paidAt: { type: Date },
    paidExpenseId: { type: String, default: "" },
    notes: { type: String, default: "" },
  },
  { timestamps: true },
);

commissionRecordSchema.index({ organizationId: 1, salespersonId: 1, status: 1 });
commissionRecordSchema.index({ organizationId: 1, invoiceId: 1, basis: 1 }, { unique: true });

export type CommissionRecordDoc = InferSchemaType<typeof commissionRecordSchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
};

export const CommissionRecord = model("CommissionRecord", commissionRecordSchema);
