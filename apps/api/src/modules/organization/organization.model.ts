import { Schema, model, type InferSchemaType } from "mongoose";

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
  },
  { timestamps: true },
);

export type OrganizationDoc = InferSchemaType<typeof organizationSchema>;
export const Organization = model("Organization", organizationSchema);
