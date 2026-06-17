import { Schema, model, Types, type InferSchemaType } from "mongoose";

const addressSchema = new Schema(
  {
    street: { type: String, default: "" },
    city: { type: String, default: "" },
    state: { type: String, default: "" },
    zip: { type: String, default: "" },
    country: { type: String, default: "" },
  },
  { _id: false },
);

const vendorSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    vendorCode: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    phone: { type: String, required: true, trim: true },
    companyName: { type: String, default: "" },
    currency: { type: String, default: "AED" },
    vatNumber: { type: String, default: "" },
    billingAddress: { type: addressSchema, default: () => ({}) },
    status: { type: String, enum: ["active", "archived"], default: "active" },
    tagIds: [{ type: Schema.Types.ObjectId, ref: "Tag" }],
  },
  { timestamps: true },
);

vendorSchema.index({ organizationId: 1, vendorCode: 1 }, { unique: true });
vendorSchema.index({ organizationId: 1, email: 1 });

export type VendorDoc = InferSchemaType<typeof vendorSchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
};
export const Vendor = model("Vendor", vendorSchema);
