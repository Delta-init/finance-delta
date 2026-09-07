import { z } from "zod";
import { tagRefSchema } from "./tag.schema";
import { departmentRefSchema } from "./department.schema";

export const createUserSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").max(80),
  email: z.string().email("Enter a valid email"),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128),
  roleId: z.string().min(1, "Select a role"),
  departmentId: z.string().optional(),
  tagIds: z.array(z.string()).optional().default([]),
  /**
   * Platform-wide access: every organization, every permission. Not a role —
   * the person still holds one here, and the flag sits above it. Only an
   * existing super admin may set this; the server refuses anybody else, so an
   * organization administrator cannot promote themselves out of their own
   * organization.
   */
  isSuperAdmin: z.boolean().optional().default(false),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  roleId: z.string().min(1).optional(),
  departmentId: z.string().nullable().optional(),
  status: z.enum(["active", "suspended"]).optional(),
  tagIds: z.array(z.string()).optional(),
  /** Granted and taken away only by somebody who already holds it. */
  isSuperAdmin: z.boolean().optional(),
});
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
  status: z.enum(["active", "suspended"]),
  role: z.object({ id: z.string(), key: z.string(), name: z.string() }),
  isSuperAdmin: z.boolean().optional().default(false),
  department: departmentRefSchema.nullable().optional(),
  tags: z.array(tagRefSchema).default([]),
  createdAt: z.string(),
});
export type User = z.infer<typeof userSchema>;
