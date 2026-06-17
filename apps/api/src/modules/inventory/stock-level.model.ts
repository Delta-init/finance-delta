import { Schema, model, Types, type InferSchemaType } from "mongoose";

const stockLevelSchema = new Schema(
  {
    organizationId: { type: Types.ObjectId, required: true },
    itemId: { type: Types.ObjectId, required: true, ref: "Item" },
    itemName: { type: String, required: true },
    sku: { type: String, required: true },
    warehouseId: { type: Types.ObjectId, required: true, ref: "Warehouse" },
    warehouseName: { type: String, required: true },
    quantityOnHand: { type: Number, default: 0 },
    avgCostMinor: { type: Number, default: 0 },
  },
  { timestamps: true },
);

stockLevelSchema.index(
  { organizationId: 1, itemId: 1, warehouseId: 1 },
  { unique: true },
);
stockLevelSchema.index({ organizationId: 1, itemId: 1 });
stockLevelSchema.index({ organizationId: 1, warehouseId: 1 });

export type StockLevelDoc = InferSchemaType<typeof stockLevelSchema> & { _id: Types.ObjectId };
export const StockLevel = model<StockLevelDoc>("StockLevel", stockLevelSchema);
