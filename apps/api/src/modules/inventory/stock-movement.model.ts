import { Schema, model, Types, type InferSchemaType } from "mongoose";

const stockMovementSchema = new Schema(
  {
    organizationId: { type: Types.ObjectId, required: true, index: true },
    itemId: { type: Types.ObjectId, required: true, ref: "Item" },
    itemName: { type: String, required: true },
    sku: { type: String, required: true },
    warehouseId: { type: Types.ObjectId, required: true, ref: "Warehouse" },
    warehouseName: { type: String, required: true },
    movementType: {
      type: String,
      enum: ["purchase_in", "invoice_out", "adjustment_in", "adjustment_out", "transfer_in", "transfer_out", "opening"],
      required: true,
    },
    quantity: { type: Number, required: true },
    unitCostMinor: { type: Number, default: 0 },
    totalCostMinor: { type: Number, default: 0 },
    beforeQty: { type: Number, required: true },
    afterQty: { type: Number, required: true },
    reference: { type: String, default: "" },
    referenceType: {
      type: String,
      enum: ["invoice", "purchase_order", "adjustment", "transfer", "manual"],
      required: true,
    },
    referenceId: { type: String },
    adjustmentReason: {
      type: String,
      enum: ["shrinkage", "damage", "write_off", "found", "correction", "opening_stock", "other"],
    },
    notes: { type: String, default: "" },
    createdByName: { type: String, default: "" },
    movementDate: { type: Date, required: true },
  },
  { timestamps: true },
);

stockMovementSchema.index({ organizationId: 1, itemId: 1, movementDate: -1 });
stockMovementSchema.index({ organizationId: 1, warehouseId: 1 });
stockMovementSchema.index({ organizationId: 1, referenceId: 1 });
stockMovementSchema.index({ organizationId: 1, movementType: 1 });

export type StockMovementDoc = InferSchemaType<typeof stockMovementSchema> & { _id: Types.ObjectId };
export const StockMovement = model<StockMovementDoc>("StockMovement", stockMovementSchema);
