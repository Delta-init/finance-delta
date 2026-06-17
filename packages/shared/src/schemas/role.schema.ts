import { z } from "zod";
import { PERMISSIONS } from "../constants/permissions";

const permissionEnum = z.enum(
  PERMISSIONS as unknown as [string, ...string[]],
);

export const createRoleSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").max(50),
  description: z.string().max(200).optional().default(""),
  permissions: z
    .array(permissionEnum)
    .min(1, "Select at least one permission"),
});
export type CreateRoleInput = z.infer<typeof createRoleSchema>;

export const updateRoleSchema = createRoleSchema.partial();
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;

export const roleSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  description: z.string(),
  permissions: z.array(z.string()),
  isSystem: z.boolean(),
});
export type Role = z.infer<typeof roleSchema>;
