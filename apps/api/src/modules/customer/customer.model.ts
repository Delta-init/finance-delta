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

const customerSchema = new Schema(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    customerCode: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    phone: { type: String, required: true, trim: true },
    companyName: { type: String, default: "" },
    currency: { type: String, default: "AED" },
    vatNumber: { type: String, default: "" },
    discountPct: { type: Number, default: 0, min: 0, max: 100 },
    billingAddress: { type: addressSchema, default: () => ({}) },
    shippingAddress: { type: addressSchema, default: () => ({}) },
    status: { type: String, enum: ["active", "archived"], default: "active" },
    departmentId: { type: Schema.Types.ObjectId, ref: "Department" },
    tagIds: [{ type: Schema.Types.ObjectId, ref: "Tag" }],
  },
  { timestamps: true },
);

customerSchema.index({ organizationId: 1, customerCode: 1 }, { unique: true });
customerSchema.index({ organizationId: 1, email: 1 });

export type CustomerDoc = InferSchemaType<typeof customerSchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
};
export const Customer = model("Customer", customerSchema);
