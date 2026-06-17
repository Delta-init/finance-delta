import { z } from "zod";

/** Token-based tag colors (mapped to OKLCH in the UI), not free hex. */
export const TAG_COLORS = [
  "slate",
  "blue",
  "green",
  "amber",
  "red",
  "violet",
  "pink",
  "teal",
] as const;
export type TagColor = (typeof TAG_COLORS)[number];
export const tagColorSchema = z.enum(TAG_COLORS);

export const createTagSchema = z.object({
  name: z.string().min(1, "Name is required").max(40),
  color: tagColorSchema.optional().default("blue"),
});
export type CreateTagInput = z.infer<typeof createTagSchema>;

export const updateTagSchema = createTagSchema.partial();
export type UpdateTagInput = z.infer<typeof updateTagSchema>;

export const tagSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: tagColorSchema,
  createdAt: z.string(),
});
export type Tag = z.infer<typeof tagSchema>;

/** Lightweight tag reference embedded in tagged-entity DTOs. */
export const tagRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: tagColorSchema,
});
export type TagRef = z.infer<typeof tagRefSchema>;
