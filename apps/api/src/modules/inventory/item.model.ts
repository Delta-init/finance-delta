import { Schema, model, Types, type InferSchemaType } from "mongoose";

const itemSchema = new Schema(
  {
    organizationId: { type: Types.ObjectId, required: true, index: true },
    itemNumber: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    sku: { type: String, required: true, trim: true },
    type: { type: String, enum: ["product", "service"], default: "product" },
    unit: {
      type: String,
      enum: ["each", "kg", "g", "liter", "ml", "meter", "cm", "box", "set", "hour", "day", "pair", "dozen", "pack"],
      default: "each",
    },
    unitPriceMinor: { type: Number, default: 0 },
    costPriceMinor: { type: Number, default: 0 },
    trackStock: { type: Boolean, default: true },
    reorderPoint: { type: Number, default: 0 },
    reorderQty: { type: Number, default: 0 },
    photoUrl: { type: String },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

itemSchema.index({ organizationId: 1, sku: 1 }, { unique: true });
itemSchema.index({ organizationId: 1, itemNumber: 1 }, { unique: true });
itemSchema.index({ organizationId: 1, name: 1 });
itemSchema.index({ organizationId: 1, isActive: 1 });

export type ItemDoc = InferSchemaType<typeof itemSchema> & { _id: Types.ObjectId };
export const Item = model<ItemDoc>("Item", itemSchema);
