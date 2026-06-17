import { Schema, model, Types, type InferSchemaType } from "mongoose";

const priceListEntrySchema = new Schema(
  {
    itemId: { type: Types.ObjectId, required: true, ref: "Item" },
    itemName: { type: String, default: "" },
    sku: { type: String, default: "" },
    unitPriceMinor: { type: Number, required: true, min: 0 },
    discountPct: { type: Number, default: 0 },
    markupPct: { type: Number, default: 0 },
  },
  { _id: false },
);

const priceListSchema = new Schema(
  {
    organizationId: { type: Types.ObjectId, required: true, index: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    isDefault: { type: Boolean, default: false },
    currency: { type: String, default: "AED" },
    validFrom: { type: Date },
    validTo: { type: Date },
    entries: { type: [priceListEntrySchema], default: [] },
  },
  { timestamps: true },
);

priceListSchema.index({ organizationId: 1, name: 1 });
priceListSchema.index({ organizationId: 1, isDefault: 1 });

export type PriceListDoc = InferSchemaType<typeof priceListSchema> & { _id: Types.ObjectId };
export const PriceList = model<PriceListDoc>("PriceList", priceListSchema);
