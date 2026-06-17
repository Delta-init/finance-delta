import { z } from "zod";

export const updateOrganizationSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  legalName: z.string().max(200).optional(),
  baseCurrency: z.string().min(3).max(3).optional(),
  branding: z
    .object({
      logoUrl: z.string().url("Must be a valid URL").or(z.literal("")).optional(),
      primaryColor: z.string().max(20).optional(),
      footerText: z.string().max(500).optional(),
    })
    .optional(),
  reminderIntervals: z.array(z.coerce.number().int().min(-365).max(365)).max(10).optional(),
});
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;

export const organizationSchema = z.object({
  id: z.string(),
  name: z.string(),
  legalName: z.string(),
  baseCurrency: z.string(),
  branding: z.object({
    logoUrl: z.string(),
    primaryColor: z.string(),
    footerText: z.string(),
  }),
  reminderIntervals: z.array(z.number()),
  updatedAt: z.string(),
});
export type OrganizationSettings = z.infer<typeof organizationSchema>;
