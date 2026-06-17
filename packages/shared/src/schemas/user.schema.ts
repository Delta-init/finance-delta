import { z } from "zod";
import { tagRefSchema } from "./tag.schema";

export const createUserSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").max(80),
  email: z.string().email("Enter a valid email"),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128),
  roleId: z.string().min(1, "Select a role"),
  tagIds: z.array(z.string()).optional().default([]),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  roleId: z.string().min(1).optional(),
  status: z.enum(["active", "suspended"]).optional(),
  tagIds: z.array(z.string()).optional(),
});
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
  status: z.enum(["active", "suspended"]),
  role: z.object({ id: z.string(), key: z.string(), name: z.string() }),
  tags: z.array(tagRefSchema).default([]),
  createdAt: z.string(),
});
export type User = z.infer<typeof userSchema>;
