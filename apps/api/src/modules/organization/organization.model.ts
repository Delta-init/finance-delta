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
    address: {
      line1:    { type: String, default: "" },
      line2:    { type: String, default: "" },
      city:     { type: String, default: "" },
      state:    { type: String, default: "" },
      postcode: { type: String, default: "" },
      country:  { type: String, default: "" },
    },
    phone:   { type: String, default: "" },
    email:   { type: String, default: "" },
    website: { type: String, default: "" },
    // One field for GSTIN / TRN / VAT number: an organization only ever holds
    // one, and only the name for it changes with where it trades.
    taxRegistrationNumber: { type: String, default: "" },
    registrationNumber:    { type: String, default: "" },
    invoiceDefaults: {
      title:         { type: String, default: "" },
      prefix:        { type: String, default: "" },
      numberPad:     { type: Number, default: 5 },
      terms:         { type: String, default: "" },
      bankAccountId: { type: String, default: "" },
      roundTotals:   { type: Boolean, default: false },
      hsnSac:        { type: String, default: "" },
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
