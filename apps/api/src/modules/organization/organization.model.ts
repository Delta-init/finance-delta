import { Schema, model, type InferSchemaType } from "mongoose";

const taxRateSchema = new Schema(
  {
    label:     { type: String, required: true },
    code:      { type: String, required: true },
    rate:      { type: Number, required: true, min: 0, max: 100 },
    isDefault: { type: Boolean, default: false },
    appliesTo: { type: String, enum: ["sales", "purchases", "both"], default: "both" },
  },
  { _id: false },
);

const organizationSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    legalName: { type: String, trim: true },
    baseCurrency: { type: String, default: "AED" },
    branding: {
      logoUrl: { type: String, default: "" },
      primaryColor: { type: String, default: "" },
      footerText: { type: String, default: "" },
    },
    reminderIntervals: { type: [Number], default: [-3, 1, 7] },
    taxSystem: { type: String, enum: ["vat", "gst", "sales_tax", "wht", "none", "custom"], default: "vat" },
    taxLabel:  { type: String, default: "VAT" },
    taxRates:  { type: [taxRateSchema], default: [] },
  },
  { timestamps: true },
);

export type OrganizationDoc = InferSchemaType<typeof organizationSchema>;
export const Organization = model("Organization", organizationSchema);
