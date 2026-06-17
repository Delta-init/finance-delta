import { Schema, model, Types, type InferSchemaType } from "mongoose";

const warehouseSchema = new Schema(
  {
    organizationId: { type: Types.ObjectId, required: true, index: true },
    name: { type: String, required: true, trim: true },
    location: { type: String, default: "" },
    isDefault: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

warehouseSchema.index({ organizationId: 1, name: 1 }, { unique: true });
warehouseSchema.index({ organizationId: 1, isDefault: 1 });

export type WarehouseDoc = InferSchemaType<typeof warehouseSchema> & { _id: Types.ObjectId };
export const Warehouse = model<WarehouseDoc>("Warehouse", warehouseSchema);
