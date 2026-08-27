import { z } from "zod";

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, "Must be a valid id");
const period = z.string().regex(/^\d{4}-\d{2}$/, "Period must be YYYY-MM");

export const importPreviewQuerySchema = z.object({ hrmsOrgId: objectId, period });
export const importRunSchema = z.object({ hrmsOrgId: objectId, period });

export const runQuerySchema = z.object({
  period: period.optional(),
  status: z.enum(["imported", "additions", "approved", "partially_paid", "paid", "returned", "voided"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
