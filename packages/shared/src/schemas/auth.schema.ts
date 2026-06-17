import { z } from "zod";

export const loginSchema = z.object({
  email: z.string().email("Enter a valid email"),
  password: z.string().min(1, "Password is required"),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshInput = z.infer<typeof refreshSchema>;

/** Shape returned to the client on a successful auth. */
export const authUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
  organizationId: z.string(),
  roleKey: z.string(),
  roleName: z.string(),
  permissions: z.array(z.string()),
});
export type AuthUser = z.infer<typeof authUserSchema>;

export const authResultSchema = z.object({
  user: authUserSchema,
  accessToken: z.string(),
  refreshToken: z.string(),
});
export type AuthResult = z.infer<typeof authResultSchema>;
